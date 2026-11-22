import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadBundledNumericReference,
  loadBundledTokenizerReference,
} from '../src/identity/bundled-references.js';

// Artifact integrity is checked before model traffic and is verified directly on real files.
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'audit-reference-'));
  await cp(
    fileURLToPath(new URL('../assets/references/', import.meta.url)),
    directory,
    { recursive: true }
  );
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe('user cannot silently replace the reference data of an audit version', () => {
  it.each(['shared_detector.bin', 'unified_bank.json', 'tokenizer_bank.json'])(
    'user rejects a corrupted shipped file %s',
    async (file) => {
      // Given one byte changed in a reference file after packaging.
      const bytes = await readFile(join(directory, file));
      bytes[bytes.length - 1] ^= 1;
      await writeFile(join(directory, file), bytes);
      // When the installed reference is prepared for scoring.
      const loading =
        file === 'tokenizer_bank.json'
          ? loadBundledTokenizerReference(directory)
          : loadBundledNumericReference(directory);
      // Then hash verification refuses altered data even when its length is unchanged.
      await expect(loading).rejects.toThrow(
        `Bundled reference integrity failed: ${file}`
      );
    }
  );

  it.each([null, { schemaVersion: 2 }, { schemaVersion: 1, owner: 'other' }])(
    'user rejects an invalid reference manifest %j',
    async (manifest) => {
      // Given a missing or incompatible manifest contract.
      await writeFile(
        join(directory, 'manifest.json'),
        JSON.stringify(manifest)
      );
      // When the caller loads bundled numeric references.
      const loading = loadBundledNumericReference(directory);
      // Then the manifest is refused before any scoring data is trusted.
      await expect(loading).rejects.toThrow(
        'Invalid bundled reference manifest'
      );
    }
  );
});
