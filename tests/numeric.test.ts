import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAudit } from '../src/index.js';
import { FeatureRelay } from './feature-relay.js';
import { writeNumericFixture } from './numeric-fixture.js';

let relay: FeatureRelay;
let baseUrl: string;
let directory: string;
beforeEach(async () => {
  relay = new FeatureRelay();
  baseUrl = await relay.start();
  directory = await mkdtemp(join(tmpdir(), 'lmspeed-numeric-'));
});
afterEach(async () => {
  await relay.close();
  await rm(directory, { recursive: true, force: true });
});
const options = { networkPolicy: 'local' as const };

describe('user uses number fingerprints as closed-set screening', () => {
  it('user receives offline candidate rankings without an identity pass', async () => {
    // Given a locally pinned scoring artifact and three valid numeric answers.
    const detectorSha256 = await writeNumericFixture(directory);
    relay.mode = 'numbers';
    // When the user runs screening through the shared bounded transport.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'a' },
        apiKey: 'local-key',
        probes: ['numeric_fingerprint'],
        numericFingerprint: { dataDirectory: directory, detectorSha256 },
      },
      options
    );
    // Then successful ranking stays explicitly distinct from identity confirmation.
    expect(report.probes[0]?.observations).toMatchObject({
      decision: 'ranked',
      scope: 'reference-closed-set',
      candidates: [{ model: 'a' }, { model: 'b' }],
    });
    expect(report.probes[0]?.verdict).toBe('inconclusive');
    expect(report.findings).toEqual([]);
    expect(report.usage.requests).toBe(3);
  });
  it('user rejects a reference artifact with the wrong digest before requests', async () => {
    // Given a local artifact whose expected digest does not match.
    await writeNumericFixture(directory);
    // When the user requests screening with an incorrect pin.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model' },
        apiKey: 'local-key',
        probes: ['numeric_fingerprint'],
        numericFingerprint: {
          dataDirectory: directory,
          detectorSha256: 'f'.repeat(64),
        },
      },
      options
    );
    // Then modified scoring data cannot silently change a result.
    expect(report.probes[0]?.observations.reason).toBe(
      'numeric_artifact_integrity'
    );
    expect(relay.requests).toBe(0);
  });
  it('user cannot screen with an expired reference bank', async () => {
    // Given a correctly pinned but old reference.
    const detectorSha256 = await writeNumericFixture(
      directory,
      '2000-01-01T00:00:00Z'
    );
    // When the user requests fresh evidence.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model' },
        apiKey: 'local-key',
        probes: ['numeric_fingerprint'],
        numericFingerprint: { dataDirectory: directory, detectorSha256 },
      },
      options
    );
    // Then the stale bank is refused without model traffic.
    expect(report.probes[0]?.observations.reason).toBe(
      'stale_numeric_reference'
    );
    expect(relay.requests).toBe(0);
  });
});
