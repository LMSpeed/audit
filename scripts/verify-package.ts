import { readdir, readFile } from 'node:fs/promises';
import { ENGINE_VERSION } from '../src/engine.js';

const manifest = JSON.parse(await readFile('package.json', 'utf8')) as {
  version: string;
  license: string;
  files: string[];
  dependencies?: Record<string, string>;
  exports: Record<string, { types: string; import: string }>;
};
if (manifest.version !== ENGINE_VERSION || manifest.license !== 'Apache-2.0')
  throw new Error(
    'Package version and Apache-2.0 license must match the engine'
  );
if (
  Object.keys(manifest.dependencies ?? {}).some((name) =>
    name.startsWith('@lmspeed/')
  )
)
  throw new Error('Public runtime must not depend on the host platform');
const license = await readFile('LICENSE', 'utf8');
if (
  !license.includes('Apache License') ||
  !license.includes('Version 2.0, January 2004')
)
  throw new Error('Missing Apache-2.0 license text');
for (const entry of Object.values(manifest.exports)) {
  await readFile(entry.types);
  await readFile(entry.import);
}
for (const file of [
  'NOTICE',
  'THIRD_PARTY_NOTICES.md',
  'docs/acceptance.md',
  'docs/strategy-review.md',
])
  await readFile(file);
const visit = async (directory: string): Promise<void> => {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await visit(path);
    else if (/\.(?:ts|js|json)$/.test(entry.name)) {
      const content = await readFile(path, 'utf8');
      if (/@lmspeed\/platform/.test(content))
        throw new Error(
          `Host workspace imports must not appear in standalone package code: ${path}`
        );
    }
  }
};
await visit('src');
await visit('dist');
const thirdParty = await readFile('THIRD_PARTY_NOTICES.md', 'utf8');
if (
  !thirdParty.includes('MIT License') ||
  !thirdParty.includes('xqy2006') ||
  !thirdParty.includes('lmfpd-sdk')
)
  throw new Error('Retained MIT components require notices');
process.stdout.write(
  'Apache license, artifacts, MIT notices and public source boundary verified\n'
);
