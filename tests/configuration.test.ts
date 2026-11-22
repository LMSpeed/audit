import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAudit } from '../src/index.js';
import type { AuditInput } from '../src/schema/index.js';
import { FeatureRelay } from './feature-relay.js';
import { tokenizerFixture } from './identity-fixtures.js';

let relay: FeatureRelay;
let baseUrl: string;
beforeEach(async () => {
  relay = new FeatureRelay();
  baseUrl = await relay.start();
});
afterEach(async () => {
  await relay.close();
});

describe('user rejects invalid detector budgets before any model call', () => {
  it.each([
    { context: { sizes: [0] } },
    { context: { sizes: [512], positions: [0.9, 0.1] } },
    { generation: { maxOutputTokens: 0 } },
    { generation: { temperature: Number.NaN } },
    { tokenizer: { bank: tokenizerFixture(), maximumProbes: 0 } },
    {
      numericFingerprint: {
        dataDirectory: '/tmp/unused',
        detectorSha256: 'a'.repeat(64),
        maximumAgeDays: 0,
      },
    },
  ])('user rejects invalid sampling configuration %j', async (config) => {
    // Given invalid lengths, ordering, generation parameters or sampling limits.
    const input: AuditInput = {
      target: { baseUrl, modelId: 'test-model' },
      apiKey: 'local-key',
      probes: ['quality_canary'],
      ...config,
    };
    // When the user requests an audit.
    const operation = runAudit(input, { networkPolicy: 'local' });
    // Then the invalid plan is rejected before credentials are sent.
    await expect(operation).rejects.toThrow(/Invalid/);
    expect(relay.requests).toBe(0);
  });
});
