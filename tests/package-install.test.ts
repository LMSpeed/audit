import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUDIT_PROBE_IDS, ENGINE_VERSION } from '../src/index.js';
import { FeatureRelay } from './feature-relay.js';

const exec = promisify(execFile);
let directory: string;
let installation: string;
const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

// Surface: installable tarball and CLI, outside the source workspace.
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'audit-package-'));
  await exec(packageManager, ['pack', '--pack-destination', directory]);
  const archive = (await readdir(directory)).find((file) =>
    file.endsWith('.tgz')
  );
  if (!archive) throw new Error('No installable package was produced');
  installation = join(directory, 'consumer');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(installation);
  await writeFile(
    join(installation, 'package.json'),
    JSON.stringify({
      private: true,
      type: 'module',
      packageManager: 'pnpm@10.31.0',
    })
  );
  await exec(
    packageManager,
    [
      'add',
      '--ignore-workspace',
      '--prod',
      '--ignore-scripts',
      join(directory, archive),
    ],
    { cwd: installation }
  );
}, 60_000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe('user installs the published CLI without the source repository', () => {
  it('user runs shipped fingerprints from the installed SDK and CLI without a website bootstrap', async () => {
    // Given a clean installation and a local model endpoint, with outbound proxies unavailable.
    const relay = new FeatureRelay();
    relay.mode = 'numbers';
    const baseUrl = await relay.start();
    const env = {
      ...process.env,
      PROVIDER_API_KEY: 'installed-reference-key',
      NODE_USE_ENV_PROXY: '1',
      HTTPS_PROXY: 'http://127.0.0.1:1',
      HTTP_PROXY: 'http://127.0.0.1:1',
      NO_PROXY: '127.0.0.1,localhost',
    };
    try {
      // When the SDK runs using only target credentials and the CLI selects the same reference checks.
      const sdk = await exec(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import {runAudit} from '@lmspeed/audit'; const report = await runAudit({target:{baseUrl:${JSON.stringify(baseUrl)},modelId:'gpt-4o'},apiKey:process.env.PROVIDER_API_KEY,probes:['numeric_fingerprint','tokenizer_fingerprint']},{networkPolicy:'local'}); process.stdout.write(JSON.stringify(report));`,
        ],
        { cwd: installation, env }
      );
      let cliOutput: string;
      try {
        cliOutput = (
          await exec(
            process.execPath,
            [
              join(
                installation,
                'node_modules/@lmspeed/audit/dist/cli/index.js'
              ),
              'scan',
              '--url',
              baseUrl,
              '--model',
              'gpt-4o',
              '--probes',
              'numeric_fingerprint,tokenizer_fingerprint',
              '--allow-private',
            ],
            { cwd: installation, env }
          )
        ).stdout;
      } catch (error) {
        const failure = error as Error & { code?: number; stdout?: string };
        if (failure.code !== 2 || !failure.stdout) throw error;
        cliOutput = failure.stdout;
      }
      // Then both independent entrypoints report the same owned, versioned reference evidence.
      for (const output of [sdk.stdout, cliOutput]) {
        const report = JSON.parse(output) as {
          probes: Array<{
            observations: {
              reference: { owner: string; version: string };
              reason?: string;
            };
          }>;
        };
        expect(report.probes).toHaveLength(2);
        expect(
          report.probes.map((probe) => probe.observations.reference.owner)
        ).toEqual(['LMSpeed/audit', 'LMSpeed/audit']);
        expect(
          report.probes.map((probe) => probe.observations.reference.version)
        ).toEqual(['ikale-70159b7536a2', 'ikale-70159b7536a2']);
        expect(output).not.toContain('installed-reference-key');
      }
    } finally {
      await relay.close();
    }
  });
  it('user receives all three language guides with working local documentation links', async () => {
    // Given a clean installation from the actual publishable tarball.
    const root = join(installation, 'node_modules/@lmspeed/audit');
    // When the user opens the documentation shipped with the package.
    const guides = ['README.md', 'README.zh-CN.md', 'README.ru.md'];
    const files = await readdir(root);
    // Then no translation or linked document is missing from the actual tarball.
    expect(files).toEqual(expect.arrayContaining(guides));
    for (const guide of guides) {
      const content = await readFile(join(root, guide), 'utf8');
      for (const [, path] of content.matchAll(
        /\]\(\.\/([^\s)#]+)(?:#[^)]*)?\)/g
      ))
        await readFile(join(root, path!));
    }
    expect(await readdir(join(root, 'assets'))).toContain('readme-preview.png');
  });

  it('user runs the installed command and imports every public SDK entry', async () => {
    // Given the command installed by the package manager.
    const cli = join(
      installation,
      'node_modules/@lmspeed/audit/dist/cli/index.js'
    );
    // When the user requests its version, catalog and documented SDK exports.
    const version = await exec(process.execPath, [cli, '--version']);
    const help = await exec(process.execPath, [cli, '--help']);
    const catalog = await exec(process.execPath, [
      cli,
      'list',
      '--format',
      'json',
    ]);
    const loaded = await exec(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        "import { readFile } from 'node:fs/promises'; const manifest = JSON.parse(await readFile('node_modules/@lmspeed/audit/package.json', 'utf8')); for (const entry of Object.keys(manifest.exports)) await import(entry === '.' ? manifest.name : manifest.name + entry.slice(1)); process.stdout.write('exports available');",
      ],
      { cwd: installation }
    );
    // Then both CLI and SDK resolve entirely from the installed package.
    expect(version.stdout.trim()).toBe(ENGINE_VERSION);
    expect(help.stdout).toContain('https://lmspeed.net/audit');
    expect(JSON.parse(catalog.stdout)).toEqual(AUDIT_PROBE_IDS);
    expect(loaded.stdout).toBe('exports available');
  });

  it('user completes a real audit through the installed package', async () => {
    // Given a real local protocol endpoint and an installed CLI.
    const relay = new FeatureRelay();
    const baseUrl = await relay.start();
    try {
      // When the installed command checks tool and schema contracts.
      const result = await exec(
        process.execPath,
        [
          join(installation, 'node_modules/@lmspeed/audit/dist/cli/index.js'),
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
          cwd: installation,
          env: { ...process.env, PROVIDER_API_KEY: 'package-install-key' },
        }
      );
      const report = JSON.parse(result.stdout) as {
        assessment: { verdict: string };
        probes: Array<{ id: string; verdict: string }>;
      };
      // Then the same engine executes both checks without exposing credentials.
      expect(report.assessment.verdict).toBe('no_findings');
      expect(report.probes.map(({ id, verdict }) => [id, verdict])).toEqual([
        ['tool_calling', 'pass'],
        ['structured_output', 'pass'],
      ]);
      expect(result.stdout + result.stderr).not.toContain(
        'package-install-key'
      );
    } finally {
      await relay.close();
    }
  });
});
