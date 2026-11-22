import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadDetector } from 'lmfpd-sdk';
import {
  type BundledReferenceManifest,
  loadBundledNumericReference,
  loadBundledTokenizerReference,
} from '../src/identity/bundled-references.js';

const source = JSON.parse(await readFile('references.source.json', 'utf8')) as {
  version: string;
  repository: string;
  commit: string;
  license: string;
  files: Record<string, string>;
  maximumAgeDays: { numeric: number; tokenizer: number };
};
if (
  !/^[a-f0-9]{40}$/.test(source.commit) ||
  !/^[\w.-]+\/[\w.-]+$/.test(source.repository)
)
  throw new Error(
    'Reference synchronization requires a pinned repository commit'
  );
const output = resolve('assets/references');
await mkdir(resolve('assets'), { recursive: true });
const staging = await mkdtemp(resolve('assets/.references-'));
const names = [
  'unified_bank.json',
  'shared_detector.bin',
  'tokenizer_bank.json',
] as const;
const manifest: BundledReferenceManifest = {
  schemaVersion: 1,
  owner: 'LMSpeed/audit',
  version: source.version,
  source: {
    repository: source.repository,
    commit: source.commit,
    license: source.license,
  },
  maximumAgeDays: source.maximumAgeDays,
  files: {},
};
try {
  await Promise.all(
    names.map(async (file) => {
      const response = await fetch(
        `https://raw.githubusercontent.com/${source.repository}/${source.commit}/data/${file}`,
        {
          redirect: 'error',
          signal: AbortSignal.timeout(60_000),
        }
      );
      if (!response.ok || !response.body)
        throw new Error(
          `Reference download failed: ${file} HTTP ${response.status}`
        );
      const chunks: Uint8Array[] = [];
      let size = 0;
      const reader = response.body.getReader();
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        size += chunk.byteLength;
        if (size > 20_000_000) {
          await reader.cancel();
          throw new Error(`Reference is too large: ${file}`);
        }
        chunks.push(chunk);
      }
      let bytes = Buffer.concat(chunks);
      const gitHash = createHash('sha1')
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest('hex');
      if (gitHash !== source.files[file])
        throw new Error(`Pinned Git blob mismatch: ${file}`);
      if (file === 'unified_bank.json') {
        const bank = JSON.parse(bytes.toString('utf8')) as {
          built_at: string;
          models: Record<string, unknown>[];
        };
        bytes = Buffer.from(
          JSON.stringify({
            built_at: bank.built_at,
            models: bank.models.map(
              ({ id, display_name, family, family_name, response_count }) => ({
                id,
                display_name,
                family,
                family_name,
                response_count,
              })
            ),
          })
        );
      }
      await writeFile(join(staging, file), bytes);
      manifest.files[file] = {
        sha256: createHash('sha256').update(bytes).digest('hex'),
        bytes: bytes.length,
      };
    })
  );
  manifest.files = Object.fromEntries(
    names.map((file) => [file, manifest.files[file]!])
  );
  await writeFile(
    join(staging, 'manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`
  );
  await loadBundledNumericReference(staging);
  await loadBundledTokenizerReference(staging);
  await loadDetector({ source: staging });
  await mkdir(output, { recursive: true });
  for (const file of [...names, 'manifest.json'])
    await rename(join(staging, file), join(output, file));
  process.stdout.write(
    `Prepared ${source.version}: ${Object.values(manifest.files).reduce((sum, file) => sum + file.bytes, 0)} bytes, no runtime downloads\n`
  );
} finally {
  await rm(staging, { recursive: true, force: true });
}
