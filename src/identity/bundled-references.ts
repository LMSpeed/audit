import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuditInput } from '../schema/index.js';
import { assertTokenizerBank, type TokenizerBank } from './tokenizer-bank.js';

export type BundledReferenceManifest = {
  schemaVersion: 1;
  owner: 'LMSpeed/audit';
  version: string;
  source: { repository: string; commit: string; license: string };
  maximumAgeDays: { numeric: number; tokenizer: number };
  files: Record<string, { sha256: string; bytes: number }>;
};

function referenceDirectory() {
  const candidates = [
    new URL('../../assets/references/', import.meta.url),
    new URL('./assets/references/', import.meta.url),
  ].map((url) => fileURLToPath(url));
  const directory = candidates.find((path) =>
    existsSync(join(path, 'manifest.json'))
  );
  if (!directory)
    throw new Error(
      'Bundled reference manifest is missing; reinstall @lmspeed/audit'
    );
  return directory;
}

async function manifestAt(directory: string) {
  const manifest = JSON.parse(
    await readFile(join(directory, 'manifest.json'), 'utf8')
  ) as BundledReferenceManifest;
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.owner !== 'LMSpeed/audit' ||
    typeof manifest.version !== 'string' ||
    !manifest.version ||
    !/^[a-f0-9]{40}$/.test(manifest.source?.commit ?? '') ||
    !['numeric', 'tokenizer'].every((key) => {
      const days = manifest.maximumAgeDays?.[key as 'numeric' | 'tokenizer'];
      return Number.isSafeInteger(days) && days >= 1 && days <= 90;
    })
  )
    throw new Error('Invalid bundled reference manifest');
  return manifest;
}

async function readVerified(
  directory: string,
  manifest: BundledReferenceManifest,
  file: string
) {
  const expected = manifest.files?.[file];
  if (
    !expected ||
    !/^[a-f0-9]{64}$/.test(expected.sha256) ||
    !Number.isSafeInteger(expected.bytes) ||
    expected.bytes < 1 ||
    expected.bytes > 20_000_000
  )
    throw new Error(`Invalid bundled reference entry: ${file}`);
  const bytes = await readFile(join(directory, file));
  if (
    bytes.length !== expected.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== expected.sha256
  )
    throw new Error(`Bundled reference integrity failed: ${file}`);
  return bytes;
}

function provenance(manifest: BundledReferenceManifest, file: string) {
  return {
    owner: manifest.owner,
    version: manifest.version,
    source: `https://github.com/${manifest.source.repository}/tree/${manifest.source.commit}`,
    sha256: manifest.files[file]!.sha256,
  };
}

export async function loadBundledNumericReference(
  directory = referenceDirectory()
) {
  const manifest = await manifestAt(directory);
  await Promise.all(
    ['unified_bank.json', 'shared_detector.bin'].map((file) =>
      readVerified(directory, manifest, file)
    )
  );
  return {
    configuration: {
      dataDirectory: directory,
      detectorSha256: manifest.files['shared_detector.bin']!.sha256,
      maximumAgeDays: manifest.maximumAgeDays.numeric,
    } satisfies NonNullable<AuditInput['numericFingerprint']>,
    provenance: provenance(manifest, 'shared_detector.bin'),
  };
}

export async function loadBundledTokenizerReference(
  directory = referenceDirectory()
) {
  const manifest = await manifestAt(directory);
  const bank: TokenizerBank = JSON.parse(
    (await readVerified(directory, manifest, 'tokenizer_bank.json')).toString(
      'utf8'
    )
  );
  assertTokenizerBank(bank);
  return {
    configuration: {
      bank,
      maximumProbes: 12,
      maxAgeDays: manifest.maximumAgeDays.tokenizer,
    } satisfies NonNullable<AuditInput['tokenizer']>,
    provenance: provenance(manifest, 'tokenizer_bank.json'),
  };
}
