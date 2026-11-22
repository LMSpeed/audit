import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FeatureRelay } from './feature-relay.js';

const exec = promisify(execFile);
let relay: FeatureRelay;
let baseUrl: string;
let directory: string;
beforeEach(async () => {
  relay = new FeatureRelay();
  baseUrl = await relay.start();
  directory = await mkdtemp(join(tmpdir(), 'engine-cli-'));
});
afterEach(async () => {
  await relay.close();
  await rm(directory, { recursive: true, force: true });
});

describe('user configures the same detector strategy through the packaged command', () => {
  it('user selects actual capability checks with a configuration file', async () => {
    // Given a configuration selecting tools, schema and objective quality checks.
    const config = join(directory, 'audit.json');
    await writeFile(
      config,
      JSON.stringify({
        probes: ['tool_calling', 'structured_output', 'quality_canary'],
      })
    );
    // When the compiled command executes against the real loopback endpoint.
    const cli = await exec(
      process.execPath,
      [
        'dist/cli/index.js',
        'scan',
        '--url',
        baseUrl,
        '--model',
        'test-model',
        '--config',
        config,
        '--allow-private',
      ],
      { env: { PATH: '/nonexistent', PROVIDER_API_KEY: 'local-private-key' } }
    );
    const report = JSON.parse(cli.stdout) as {
      probes: Array<{ id: string; verdict: string }>;
    };
    // Then configuration changes the actual executed plan and credentials stay out of output.
    expect(report.probes.map((probe) => [probe.id, probe.verdict])).toEqual([
      ['tool_calling', 'pass'],
      ['structured_output', 'pass'],
      ['quality_canary', 'pass'],
    ]);
    expect(relay.requests).toBe(15);
    expect(cli.stdout + cli.stderr).not.toContain('local-private-key');
  });
  it('user collects and reuses a frozen reference through environment-only credentials', async () => {
    // Given independently configured candidate and negative-reference routes.
    const plan = join(directory, 'collection.json');
    const output = join(directory, 'baseline.json');
    await writeFile(
      plan,
      JSON.stringify({
        contract: {
          protocol: 'openai',
          prompts: [
            'Choose a fingerprint color.',
            'Choose a fingerprint animal.',
          ],
          generation: { maxOutputTokens: 128 },
          samplesPerPrompt: 16,
        },
        sources: ['a', 'b', 'other'].map((id) => ({
          id,
          kind: id === 'other' ? 'other' : 'candidate',
          target: { baseUrl, modelId: `reference-${id}`, protocol: 'openai' },
          apiKeyEnv: `REFERENCE_${id.toUpperCase()}`,
        })),
      })
    );
    // When the user collects a reference and then runs confirmation with the saved artifact.
    await exec(
      process.execPath,
      [
        'dist/cli/index.js',
        'collect-baseline',
        '--config',
        plan,
        '--output',
        output,
        '--allow-private',
      ],
      {
        env: {
          PATH: '/nonexistent',
          REFERENCE_A: 'key-a-private',
          REFERENCE_B: 'key-b-private',
          REFERENCE_OTHER: 'key-other-private',
        },
      }
    );
    const config = join(directory, 'confirm.json');
    await writeFile(
      config,
      JSON.stringify({
        probes: ['model_fingerprint'],
        identity: { baselineFile: './baseline.json', claimedModel: 'a' },
      })
    );
    const cli = await exec(
      process.execPath,
      [
        'dist/cli/index.js',
        'scan',
        '--url',
        baseUrl,
        '--model',
        'test-model',
        '--config',
        config,
        '--allow-private',
      ],
      { env: { PATH: '/nonexistent', PROVIDER_API_KEY: 'target-private-key' } }
    );
    const report = JSON.parse(cli.stdout) as {
      probes: Array<{ observations: { decision: string } }>;
    };
    // Then the reusable baseline has valid provenance and contains no collection credentials.
    expect(report.probes[0]?.observations.decision).toBe('reference_match');
    const saved = await readFile(output, 'utf8');
    expect(JSON.parse(saved).baseline.calibration.status).toBe('validated');
    expect(saved).not.toContain('key-a-private');
  });
});
