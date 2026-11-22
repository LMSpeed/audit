import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { collectFingerprintBaseline, runAudit } from '../src/index.js';
import type { FingerprintCollection } from '../src/schema/index.js';
import { FeatureRelay } from './feature-relay.js';

let relay: FeatureRelay;
let baseUrl: string;
beforeEach(async () => {
  relay = new FeatureRelay();
  baseUrl = await relay.start();
});
afterEach(async () => {
  await relay.close();
});
function collection(): FingerprintCollection {
  return {
    contract: {
      protocol: 'openai',
      prompts: ['Choose a fingerprint color.', 'Choose a fingerprint animal.'],
      generation: { maxOutputTokens: 128 },
      samplesPerPrompt: 16,
    },
    sources: ['a', 'b', 'other'].map((id) => ({
      id,
      kind: id === 'other' ? 'other' : 'candidate',
      target: { baseUrl, modelId: `reference-${id}`, protocol: 'openai' },
      apiKey: `private-${id}-key`,
    })),
  };
}

describe('user creates reusable references from independently collected batches', () => {
  it('user collects, freezes and reuses a validated reference without storing keys', async () => {
    // Given candidate and external-reference routes under one fixed sampling contract.
    const plan = collection();
    // When training and validation batches are collected and then used for confirmation.
    const collected = await collectFingerprintBaseline(plan, {
      networkPolicy: 'local',
    });
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model', protocol: 'openai' },
        apiKey: 'local-key',
        probes: ['model_fingerprint'],
        identity: { baseline: collected.baseline, claimedModel: 'a' },
      },
      { networkPolicy: 'local' }
    );
    // Then the holdout is complete, the baseline works and secrets never enter the artifact.
    expect(collected.baseline.calibration).toMatchObject({
      status: 'validated',
      heldOutCorrect: 3,
      heldOutTotal: 3,
    });
    expect(collected.usage.requests).toBe(192);
    expect(collected.failures).toEqual([]);
    expect(report.probes[0]?.observations.decision).toBe('reference_match');
    expect(JSON.stringify(collected)).not.toContain('private-a-key');
  });
  it('user retains failed collection evidence without receiving a usable calibration', async () => {
    // Given insufficient request budget for independent train and holdout batches.
    const plan = collection();
    // When collection reaches the shared three-request cap.
    const collected = await collectFingerprintBaseline(plan, {
      networkPolicy: 'local',
      limits: { maxRequests: 3 },
    });
    // Then missing acquisition is preserved and cannot be exported as calibrated evidence.
    expect(collected.usage.requests).toBe(3);
    expect(collected.baseline.calibration.status).toBe('insufficient');
    expect(collected.failures.map((f) => f.outcome)).toContain('error');
  });
  it('user cannot collect a reference without external negative sources', async () => {
    // Given only the two claimed candidate routes.
    const plan = collection();
    plan.sources = plan.sources.slice(0, 2);
    // When the user attempts calibration.
    const operation = collectFingerprintBaseline(plan, {
      networkPolicy: 'local',
    });
    // Then an invalid plan fails before consuming any request.
    await expect(operation).rejects.toThrow('external reference');
    expect(relay.requests).toBe(0);
  });
});
