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
  it.each(['claude-opus-5-5', 'Anthropic/CLAUDE-OPUS-5-5:online'])(
    'user collects numeric evidence for %s when the reference spells the same version with a dot',
    async (modelId) => {
      // Given the packaged numeric bank contains Claude Opus 5.5 samples, while the tokenizer bank has no Claude class.
      relay.mode = 'numbers';
      // When the user audits both fingerprints using the provider's model ID.
      const report = await runAudit(
        {
          target: { baseUrl, modelId },
          apiKey: 'alias-contract-key',
          probes: ['numeric_fingerprint', 'tokenizer_fingerprint'],
        },
        { networkPolicy: 'local' }
      );
      // Then numeric screening produces a ranking while only the tokenizer check skips without sampling.
      const [numeric, tokenizer] = report.probes;
      expect(numeric).toMatchObject({
        execution: 'completed',
        observations: {
          decision: 'ranked',
          referenceMatch: {
            requestedModelId: modelId,
            referenceModelId: 'claude-opus-5.5',
            responseCount: 36,
          },
        },
      });
      expect(tokenizer).toMatchObject({
        execution: 'skipped',
        observations: { reason: 'tokenizer_model_reference_missing' },
      });
      expect(report.coverage.skipped).toEqual(['tokenizer_fingerprint']);
      expect(report.usage.requests).toBe(3);
      expect(relay.received.map(({ body }) => body.model)).toEqual([
        modelId,
        modelId,
        modelId,
      ]);
    }
  );

  it.each([
    ['gpt-6.1-sol', 'group_alias'],
    ['OpenAI/GPT-6.1-SOL:online', 'group_alias'],
    ['gpt-6-astra', 'id'],
    ['gpt-6-sol', 'id'],
  ])(
    'user associates the declared numeric reference group for %s',
    async (modelId, matchType) => {
      // Given the pinned upstream bank explicitly combines gpt-6-astra/6.1-sol while gpt-6-sol has its own reference.
      relay.mode = 'numbers';
      // When the public SDK checks the API model ID without rewriting the actual request model.
      const report = await runAudit(
        {
          target: { baseUrl, modelId },
          apiKey: 'alias-contract-key',
          probes: ['numeric_fingerprint'],
        },
        { networkPolicy: 'local' }
      );
      // Then reference aliases permit real sampling, preserve the resolved group, and never become model-identity proof.
      const grouped = modelId !== 'gpt-6-sol';
      expect(report.usage.requests).toBe(3);
      expect(report.probes[0]?.observations).toMatchObject({
        decision: 'ranked',
        referenceMatch: {
          requestedModelId: modelId,
          referenceModelId: grouped ? 'gpt-6-astra' : 'gpt-6-sol',
          referenceDisplayName: grouped ? 'gpt-6-astra/6.1-sol' : 'gpt-6-sol',
          responseCount: grouped ? 72 : 36,
          matchType,
        },
      });
      expect(report.probes[0]?.verdict).toBe('inconclusive');
      expect(report.findings).toEqual([]);
      for (const request of relay.received)
        expect(request.body.model).toBe(modelId);
    }
  );
  it('user does not borrow an existing numeric reference for an undeclared model version', async () => {
    // Given a nearby model ID absent from the reference group's explicit names.
    relay.mode = 'numbers';
    // When the SDK checks it against the same packaged bank.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'gpt-6.1-sol-next' },
        apiKey: 'alias-contract-key',
        probes: ['numeric_fingerprint'],
      },
      { networkPolicy: 'local' }
    );
    // Then similar names cannot silently reuse a different model's samples.
    expect(report.probes[0]?.observations.reason).toBe(
      'numeric_model_reference_missing'
    );
    expect(report.coverage.skipped).toEqual(['numeric_fingerprint']);
    expect(report.usage.requests).toBe(0);
  });
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
    expect(report.usage.requests).toBeLessThanOrEqual(16);
    expect(report.probes[0]?.observations.reason).not.toBe(
      'tokenizer_bank_required'
    );
  });
});
