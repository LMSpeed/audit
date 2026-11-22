import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_RELAY_AUDIT_STEP_IDS } from '../src/catalog.js';
import { runLmspeedAudit } from '../src/compat/lmspeed.js';
import { createAuditPlan, runAudit } from '../src/index.js';
import { FeatureRelay } from './feature-relay.js';

let relay: FeatureRelay;
let baseUrl: string;
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-23T00:00:00Z'));
  relay = new FeatureRelay();
  baseUrl = await relay.start();
});
afterEach(async () => {
  vi.useRealTimers();
  await relay.close();
});

describe('user runs fingerprints from the standalone audit package', () => {
  it('user can explicitly disable the packaged reference checks', () => {
    // Given a caller opting out of bundled reference data.
    const input = {
      target: { baseUrl, modelId: 'test-model' },
      apiKey: 'local-key',
      referenceData: 'disabled' as const,
    };
    // When the SDK chooses checks and the caller also supplies a connectivity-only profile.
    const plan = createAuditPlan(input);
    const connectivity = createAuditPlan({ ...input, profile: 'connectivity' });
    // Then opt-out and lightweight connectivity remain authoritative.
    expect(plan).not.toContain('numeric_fingerprint');
    expect(plan).not.toContain('tokenizer_fingerprint');
    expect(connectivity).toEqual(['model_list', 'stream_integrity']);
  });

  it('user receives dated missing-evidence reasons when shipped references expire', async () => {
    // Given a future run after the immutable reference dates have expired.
    vi.setSystemTime(new Date('2027-06-01T00:00:00Z'));
    // When the SDK is asked to use its shipped references.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model' },
        apiKey: 'local-key',
        probes: ['numeric_fingerprint', 'tokenizer_fingerprint'],
      },
      { networkPolicy: 'local' }
    );
    // Then neither reference date is rewritten and no paid request is made.
    expect(report.probes.map((probe) => probe.observations.reason)).toEqual([
      'stale_numeric_reference',
      'stale_tokenizer_bank',
    ]);
    expect(report.usage.requests).toBe(0);
    expect(
      report.probes.every(
        (probe) =>
          probe.observations.reference && probe.verdict === 'inconclusive'
      )
    ).toBe(true);
  });
  it('user receives both packaged reference checks in the default plan', () => {
    // Given a target with no website configuration or reference paths.
    const input = {
      target: { baseUrl, modelId: 'test-model' },
      apiKey: 'local-key',
    };
    // When the SDK chooses its default checks.
    const plan = createAuditPlan(input);
    // Then numeric screening and tokenizer evidence are selected without a host bootstrap.
    expect(plan).toContain('numeric_fingerprint');
    expect(plan).toContain('tokenizer_fingerprint');
    expect(DEFAULT_RELAY_AUDIT_STEP_IDS).toContain('numeric_fingerprint');
    expect(DEFAULT_RELAY_AUDIT_STEP_IDS).toContain('tokenizer_fingerprint');
  });

  it('user receives the same bundled evidence through the website adapter', async () => {
    // Given the public adapter used by LMSpeed with no reference paths or setup.
    relay.mode = 'numbers';
    // When the adapter runs explicit fingerprint steps against a real protocol endpoint.
    const output = await runLmspeedAudit(
      { baseUrl, modelId: 'gpt-4o', apiKey: 'local-key' },
      {
        stepIds: ['numeric_fingerprint', 'tokenizer_fingerprint'],
        networkPolicy: 'local',
      }
    );
    // Then persisted website evidence comes from the standalone package's reference snapshot.
    expect(output.steps.map((step) => step.id)).toEqual([
      'numeric_fingerprint',
      'tokenizer_fingerprint',
    ]);
    for (const step of output.steps) {
      const observations = step.evidence.find(
        (entry) => entry.labelEn === 'Observations'
      );
      expect(JSON.parse(String(observations?.value)).reference.owner).toBe(
        'LMSpeed/audit'
      );
    }
  });

  it('user collects numeric samples using the shipped reference without local configuration', async () => {
    // Given an endpoint producing numeric sequences and no external artifact configuration.
    relay.mode = 'numbers';
    // When the public SDK runs the numeric check.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'gpt-4o' },
        apiKey: 'local-key',
        probes: ['numeric_fingerprint'],
      },
      { networkPolicy: 'local' }
    );
    // Then packaged data enables real collection and identifies its immutable reference version.
    expect(report.usage.requests).toBe(3);
    expect(report.probes[0]?.execution).toBe('completed');
    expect(report.probes[0]?.observations.reference).toMatchObject({
      owner: 'LMSpeed/audit',
      version: expect.any(String),
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(report.findings).toEqual([]);
  });

  it('user collects tokenizer evidence using the shipped bank without a host file', async () => {
    // Given an endpoint reporting token usage and no website-managed tokenizer bank.
    // When the public SDK runs the tokenizer check.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'gpt-4o' },
        apiKey: 'local-key',
        probes: ['tokenizer_fingerprint'],
      },
      { networkPolicy: 'local' }
    );
    // Then evidence is acquired with the package's reference and a finite request budget.
    expect(report.probes[0]?.observations.reference).toMatchObject({
      owner: 'LMSpeed/audit',
    });
    expect(report.usage.requests).toBeGreaterThanOrEqual(1);
    expect(report.usage.requests).toBeLessThanOrEqual(14);
    expect(report.probes[0]?.observations.reason).not.toBe(
      'tokenizer_bank_required'
    );
  });
});
