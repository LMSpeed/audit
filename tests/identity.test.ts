import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAudit } from '../src/index.js';
import { FeatureRelay } from './feature-relay.js';
import {
  baselineFixture,
  seal,
  tokenizerFixture,
} from './identity-fixtures.js';

let relay: FeatureRelay;
let baseUrl: string;
beforeEach(async () => {
  relay = new FeatureRelay();
  baseUrl = await relay.start();
});
afterEach(async () => {
  await relay.close();
});
const options = { networkPolicy: 'local' as const, pacingMs: 0 };
function input() {
  return {
    target: { baseUrl, modelId: 'test-model', protocol: 'openai' as const },
    apiKey: 'local-test-credential',
    probes: ['model_fingerprint'],
    identity: { baseline: baselineFixture(), claimedModel: 'a' },
  };
}

describe('user obtains model evidence with explicit abstention boundaries', () => {
  it('user confirms a reference-compatible answer distribution', async () => {
    // Given a fresh calibrated reference and a matching route.
    const request = input();
    // When the user collects the full planned sample.
    const report = await runAudit(request, options);
    // Then only reference compatibility is confirmed, with all samples accounted for.
    expect(report.probes[0]?.verdict).toBe('pass');
    expect(report.probes[0]?.observations).toMatchObject({
      decision: 'reference_match',
      candidate: 'a',
      acquired: 32,
      scheduled: 32,
    });
  });
  it('user sees a different in-reference candidate without causal attribution', async () => {
    // Given the claimed candidate A and a route behaving like reference B.
    const request = {
      ...input(),
      target: { baseUrl, modelId: 'reference-b', protocol: 'openai' as const },
    };
    // When the full distribution is acquired.
    const report = await runAudit(request, options);
    // Then the mismatch is evidence rather than a claim about malicious relay behavior.
    expect(report.probes[0]?.verdict).toBe('finding');
    expect(report.probes[0]?.observations).toMatchObject({
      decision: 'reference_mismatch',
      candidate: 'b',
    });
    expect(report.findings[0]?.confidence).toBe('moderate');
  });
  it('user abstains on answers outside every fitted reference', async () => {
    // Given a route with unseen answers that cannot fit the candidate references.
    relay.mode = 'unknown-fingerprint';
    // When the user collects an otherwise complete sample.
    const report = await runAudit(input(), options);
    // Then relative ranking cannot turn poor absolute fit into identity confirmation.
    expect(report.probes[0]?.verdict).toBe('inconclusive');
    expect(report.probes[0]?.observations.decision).toBe('abstain');
    expect(report.findings).toEqual([]);
  });
  it('user rejects an expired baseline before consuming requests', async () => {
    // Given an expired but otherwise calibrated package.
    const request = input();
    request.identity.baseline.expiresAt = '2000-01-01T00:00:00Z';
    seal(request.identity.baseline);
    // When identity confirmation is requested.
    const report = await runAudit(request, options);
    // Then stale evidence does not retain authority.
    expect(report.probes[0]?.observations.reason).toBe('stale_baseline');
    expect(relay.requests).toBe(0);
  });
  it('user rejects a modified baseline even when its version is unchanged', async () => {
    // Given a package modified without updating its content binding.
    const request = input();
    request.identity.baseline.contract.prompts[0] = 'Different question';
    // When the user requests a comparison.
    const report = await runAudit(request, options);
    // Then a mismatched content digest blocks sampling.
    expect(report.probes[0]?.observations.reason).toBe('baseline_integrity');
    expect(relay.requests).toBe(0);
  });
  it('user cannot compare references collected under different generation settings', async () => {
    // Given a reference frozen without a temperature override.
    const request = {
      ...input(),
      generation: { temperature: 1.2, maxOutputTokens: 128 },
    };
    // When a materially different request contract is supplied.
    const report = await runAudit(request, options);
    // Then comparison abstains before collecting incompatible answers.
    expect(report.probes[0]?.observations.reason).toBe('incompatible_contract');
    expect(relay.requests).toBe(0);
  });
  it('user cannot confirm identity from a budget-truncated sample', async () => {
    // Given a complete reference but only enough budget for three samples.
    const request = input();
    // When the user runs confirmation under the lower cap.
    const report = await runAudit(request, {
      ...options,
      limits: { maxRequests: 3 },
    });
    // Then partial sampling is visible and cannot yield a match.
    expect(report.usage.requests).toBe(3);
    expect(report.probes[0]?.verdict).toBe('inconclusive');
    expect(report.probes[0]?.observations.decision).toBe('abstain');
  });
});

describe('user keeps tokenizer evidence separate from model identity', () => {
  it('user identifies a compatible count class with repeated baseline controls', async () => {
    // Given a count bank and endpoint with the alpha tokenizer signature.
    const request = {
      target: { baseUrl, modelId: 'test-model', protocol: 'openai' as const },
      apiKey: 'local-test-credential',
      probes: ['tokenizer_fingerprint'],
      tokenizer: { bank: tokenizerFixture() },
    };
    // When the user runs adaptive differential probes.
    const report = await runAudit(request, options);
    // Then tokenizer compatibility is reported without certifying the model.
    expect(report.probes[0]?.verdict).toBe('pass');
    expect(report.probes[0]?.observations).toMatchObject({
      decision: 'exact',
      class: 'alpha',
      baselineDrift: false,
    });
    expect(report.usage.requests).toBeLessThanOrEqual(15);
  });
  it.each([
    {
      outcome: 'gets a tokenizer result at 94.65% confidence',
      offset: 1,
      interval: 3,
      maximumProbes: 12,
      expected: {
        verdict: 'pass',
        observations: {
          decision: 'exact',
          class: 'alpha',
          confidence: expect.closeTo(0.9465, 4),
          claim: { status: 'consistent' },
        },
      },
    },
    {
      outcome: 'still gets an inconclusive result at 89.85% confidence',
      offset: 2,
      interval: 4,
      maximumProbes: 6,
      expected: {
        verdict: 'inconclusive',
        observations: {
          decision: 'abstain',
          reason: 'unknown_or_uncertain_tokenizer',
          tokenizerVerdict: {
            kind: 'exact',
            confidence: expect.closeTo(0.8985, 4),
            claim: { status: 'consistent' },
          },
        },
      },
    },
  ])('user $outcome', async ({ offset, interval, maximumProbes, expected }) => {
    // Given stable controls and some counts that differ from the declared tokenizer family.
    const bank = tokenizerFixture();
    bank.api_models = [];
    const [alpha] = bank.classes;
    alpha!.counts = alpha!.counts.map((count, index) =>
      index % interval === 0 ? count + offset : count
    );
    // When the user runs the tokenizer probe through the configured sample budget.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model', protocol: 'openai' },
        apiKey: 'local-test-credential',
        probes: ['tokenizer_fingerprint'],
        tokenizer: { bank, maximumProbes },
      },
      options
    );
    // Then the report requires 90% exact confidence even when the family is consistent.
    const probe = report.probes[0];
    expect(probe).toMatchObject(expected);
    expect(probe?.observations.requiredConfidence).toBe(0.9);
    expect(probe?.observations.observations).toHaveLength(maximumProbes + 3);
  });
  it('user stops before adaptive sampling when identical tokenizer controls disagree', async () => {
    // Given two different token counts for the same baseline input.
    relay.tokenizerDrift = true;
    // When tokenizer measurements are otherwise consistent.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model', protocol: 'openai' },
        apiKey: 'local-test-credential',
        probes: ['tokenizer_fingerprint'],
        tokenizer: { bank: tokenizerFixture() },
      },
      options
    );
    // Then the report preserves the two control counts without spending requests on incompatible samples.
    expect(report.probes[0]?.verdict).toBe('inconclusive');
    expect(report.probes[0]?.observations).toMatchObject({
      decision: 'abstain',
      baselineDrift: true,
      observations: [
        { probe: null, tokens: 12 },
        { probe: null, tokens: 14 },
      ],
    });
    expect(report.usage.requests).toBe(2);
    expect(report.findings).toEqual([]);
  });
  it('user stops sampling when a lower count prompts a control that confirms drift', async () => {
    // Given matching opening controls and a token-count regime that changes at the first sample.
    relay.mode = 'tokenizer-midrun-drift';
    // When the user checks tokenizer compatibility.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model', protocol: 'openai' },
        apiKey: 'local-test-credential',
        probes: ['tokenizer_fingerprint'],
        tokenizer: { bank: tokenizerFixture() },
      },
      options
    );
    // Then the report retains the sample and repeated control without collecting more incompatible counts.
    expect(report.probes[0]).toMatchObject({
      verdict: 'inconclusive',
      observations: {
        reason: 'baseline_drift',
        baselineDrift: true,
        observations: [
          { probe: null, tokens: 22805 },
          { probe: null, tokens: 22805 },
          { probe: expect.any(String) },
          { probe: null, tokens: 23 },
        ],
      },
    });
  });
  it('user receives a tokenizer result when a negative difference has a matching control', async () => {
    // Given a reference that can use one fewer token for a particular nonempty probe.
    relay.mode = 'tokenizer-negative-delta';
    const bank = tokenizerFixture();
    bank.classes[0]!.counts[11] = -1;
    // When the user checks a stable endpoint with that tokenizer.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model', protocol: 'openai' },
        apiKey: 'local-test-credential',
        probes: ['tokenizer_fingerprint'],
        tokenizer: { bank },
      },
      options
    );
    // Then the negative difference alone cannot turn stable controls into a drift verdict.
    expect(report.probes[0]).toMatchObject({
      verdict: 'pass',
      observations: { decision: 'exact', class: 'alpha', baselineDrift: false },
    });
  });
  it('user does not force unlisted tokenizer counts into a known class', async () => {
    // Given a tokenizer unlike either bank class.
    relay.mode = 'tokenizer-unknown';
    // When adaptive probes reach the available evidence limit.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model', protocol: 'openai' },
        apiKey: 'local-test-credential',
        probes: ['tokenizer_fingerprint'],
        tokenizer: { bank: tokenizerFixture() },
      },
      options
    );
    // Then the unknown or uncertain result stays distinct from model identity.
    expect(report.probes[0]?.verdict).toBe('inconclusive');
    expect(report.probes[0]?.observations.decision).not.toBe('exact');
    expect(report.probes[0]?.observations.requiredConfidence).toBe(0.9);
  });
});
