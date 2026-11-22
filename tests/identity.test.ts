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
    expect(report.usage.requests).toBeLessThanOrEqual(14);
  });
  it('user abstains when the control input count drifts during sampling', async () => {
    // Given hidden request overhead changing between baseline controls.
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
    // Then drift invalidates the decision instead of merely attaching a warning.
    expect(report.probes[0]?.verdict).toBe('inconclusive');
    expect(report.probes[0]?.observations).toMatchObject({
      decision: 'abstain',
      baselineDrift: true,
    });
    expect(report.findings).toEqual([]);
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
  });
});
