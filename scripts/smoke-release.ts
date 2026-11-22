import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { AUDIT_PROBE_IDS, ENGINE_VERSION } from '../src/index.js';
import { FeatureRelay } from '../tests/feature-relay.js';

// Given the exact release artifacts that users will download.
const exec = promisify(execFile);
const output = resolve(process.argv[2] ?? '.cache/release');
const sums = await readFile(join(output, 'SHA256SUMS'), 'utf8');
for (const line of sums.trim().split('\n')) {
  const [expected, file] = line.split('  ');
  assert.match(file ?? '', /^[a-zA-Z0-9.-]+$/);
  assert.equal(
    createHash('sha256')
      .update(await readFile(join(output, file!)))
      .digest('hex'),
    expected
  );
}
// When users install either registry artifact after the repository migration.
for (const [file, registry] of [
  [`lmspeed-audit-${ENGINE_VERSION}.tgz`, undefined],
  [`lmspeed-audit-github-${ENGINE_VERSION}.tgz`, 'https://npm.pkg.github.com'],
] as const) {
  const { stdout } = await exec('tar', [
    '-xOf',
    join(output, file),
    'package/package.json',
  ]);
  const manifest = JSON.parse(stdout) as {
    name: string;
    version: string;
    repository: { url: string };
    publishConfig: { registry?: string };
  };
  // Then npm and GitHub Packages expose the canonical package and repository.
  assert.equal(manifest.name, '@lmspeed/audit');
  assert.equal(manifest.version, ENGINE_VERSION);
  assert.equal(
    manifest.repository.url.toLowerCase(),
    'git+https://github.com/lmspeed/audit.git'
  );
  assert.equal(manifest.publishConfig.registry, registry);
}
const directory = await mkdtemp(join(tmpdir(), 'audit portable-'));
try {
  const archive = join(
    output,
    `lmspeed-audit-${ENGINE_VERSION}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`
  );
  if (process.platform === 'win32')
    await exec('tar', ['-xf', archive, '-C', directory]);
  else await exec('tar', ['-xzf', archive, '-C', directory]);
  // Then all translated guides and their local links survive portable packaging.
  const documentationRoot = join(directory, 'lmspeed-audit');
  for (const guide of ['README.md', 'README.zh-CN.md', 'README.ru.md']) {
    const content = await readFile(join(documentationRoot, guide), 'utf8');
    for (const [, path] of content.matchAll(/\]\(\.\/([^\s)#]+)(?:#[^)]*)?\)/g))
      await readFile(join(documentationRoot, path!));
  }
  const cli = join(directory, 'lmspeed-audit/lmspeed-audit.mjs');
  // When the user runs the portable command outside any Node.js project.
  const version = await exec(process.execPath, [cli, '--version'], {
    cwd: directory,
  });
  const list = await exec(process.execPath, [cli, 'list', '--format', 'json'], {
    cwd: directory,
  });
  // Then the bundled runtime needs no package installation and exposes the complete catalog.
  assert.equal(version.stdout.trim(), ENGINE_VERSION);
  assert.deepEqual(JSON.parse(list.stdout), AUDIT_PROBE_IDS);
  const relay = new FeatureRelay();
  const baseUrl = await relay.start();
  try {
    const result = await exec(
      process.execPath,
      [
        cli,
        'scan',
        '--url',
        baseUrl,
        '--model',
        'test-model',
        '--probes',
        'tool_calling,structured_output',
        '--allow-private',
      ],
      {
        cwd: directory,
        env: { ...process.env, PROVIDER_API_KEY: 'portable-smoke-key' },
      }
    );
    const report = JSON.parse(result.stdout) as {
      assessment: { verdict: string };
      probes: Array<{ id: string; verdict: string }>;
    };
    assert.equal(report.assessment.verdict, 'no_findings');
    assert.deepEqual(
      report.probes.map(({ id, verdict }) => [id, verdict]),
      [
        ['tool_calling', 'pass'],
        ['structured_output', 'pass'],
      ]
    );
    assert.equal(
      (result.stdout + result.stderr).includes('portable-smoke-key'),
      false
    );
    // Given only a portable archive and a local target; When fingerprint checks run;
    // Then their owned reference assets resolve without any package or website bootstrap.
    relay.mode = 'numbers';
    let fingerprintOutput: string;
    try {
      fingerprintOutput = (
        await exec(
          process.execPath,
          [
            cli,
            'scan',
            '--url',
            baseUrl,
            '--model',
            'gpt-4o',
            '--probes',
            'numeric_fingerprint,tokenizer_fingerprint',
            '--allow-private',
          ],
          {
            cwd: directory,
            env: { ...process.env, PROVIDER_API_KEY: 'portable-reference-key' },
          }
        )
      ).stdout;
    } catch (error) {
      const failure = error as Error & { code?: number; stdout?: string };
      if (failure.code !== 2 || !failure.stdout) throw error;
      fingerprintOutput = failure.stdout;
    }
    const fingerprints = JSON.parse(fingerprintOutput) as {
      probes: Array<{ observations: { reference: { owner: string } } }>;
    };
    assert.deepEqual(
      fingerprints.probes.map((probe) => probe.observations.reference.owner),
      ['LMSpeed/audit', 'LMSpeed/audit']
    );
    assert.equal(fingerprintOutput.includes('portable-reference-key'), false);
  } finally {
    await relay.close();
  }
  if (process.platform === 'win32') {
    const result = await exec(
      'cmd.exe',
      ['/d', '/c', 'lmspeed-audit.cmd', '--version'],
      {
        cwd: join(directory, 'lmspeed-audit'),
      }
    );
    assert.equal(result.stdout.trim(), ENGINE_VERSION);
  }
  process.stdout.write(
    `Release ${ENGINE_VERSION}: checksums, portable CLI and real HTTP audit passed\n`
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
