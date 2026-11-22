import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLmspeedAudit } from '../src/compat/lmspeed.js';
import { runAudit } from '../src/index.js';
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

describe('user reads the actual token consumption of an audit', () => {
  it('user retains partial output totals and distinguishes an explicitly reported zero', async () => {
    // Given an endpoint omitting output usage after its first request.
    relay.mode = 'partial-usage';
    const input = {
      target: { baseUrl, modelId: 'test-model' },
      apiKey: 'usage-key',
      probes: ['structured_output'],
    };
    // When the SDK totals the responses, then repeats against an endpoint explicitly reporting zero.
    const partial = await runAudit(input, { networkPolicy: 'local' });
    relay.mode = 'zero-usage';
    const zero = await runAudit(input, { networkPolicy: 'local' });
    // Then omitted output is marked partial while explicit zeros stay measured values.
    expect(partial.usage).toMatchObject({
      tokens: {
        inputTokens: 24,
        outputTokens: 4,
        modelRequests: 2,
        inputReportedRequests: 2,
        outputReportedRequests: 1,
      },
    });
    expect(zero.usage).toMatchObject({
      tokens: {
        inputTokens: 0,
        outputTokens: 0,
        modelRequests: 2,
        inputReportedRequests: 2,
        outputReportedRequests: 2,
      },
    });
  });

  it('user counts reasoning output once rather than adding its breakdown to the total', async () => {
    // Given a model reporting output totals that already include reasoning tokens.
    relay.mode = 'reasoning-usage';
    // When JSON and streaming requests are compared.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model' },
        apiKey: 'usage-key',
        probes: ['stream_consistency'],
      },
      { networkPolicy: 'local' }
    );
    // Then 11 and 8 reported output tokens sum to 19, without adding 9 and 6 again.
    expect(report.usage).toMatchObject({
      tokens: { outputTokens: 19, outputReportedRequests: 2 },
    });
  });
  it('user receives reported input and output totals instead of the request budget estimate', async () => {
    // Given a real protocol endpoint reporting 12 input and 4 output tokens for each request.
    // When the SDK performs its two structured-output checks.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model' },
        apiKey: 'usage-key',
        probes: ['structured_output'],
      },
      { networkPolicy: 'local' }
    );
    // Then actual usage is totaled once per response, independently of the input-size estimate.
    expect(report.usage).toMatchObject({
      tokens: {
        inputTokens: 24,
        outputTokens: 8,
        modelRequests: 2,
        inputReportedRequests: 2,
        outputReportedRequests: 2,
      },
    });
  });

  it.each(['openai', 'anthropic', 'responses'] as const)(
    'user includes cached input once for JSON and SSE in %s',
    async (protocol) => {
      // Given cached usage returned in a JSON response and streaming response.
      relay.cached = true;
      // When the SDK compares both response modes.
      const report = await runAudit(
        {
          target: { baseUrl, modelId: 'test-model', protocol },
          apiKey: 'usage-key',
          probes: ['stream_consistency'],
        },
        { networkPolicy: 'local' }
      );
      // Then cumulative stream events and cache details cannot duplicate the request's token cost.
      expect(report.usage).toMatchObject({
        tokens: {
          inputTokens: 320,
          outputTokens: 8,
          modelRequests: 2,
          inputReportedRequests: 2,
          outputReportedRequests: 2,
        },
      });
    }
  );

  it('user sees missing usage as unknown rather than zero consumption', async () => {
    // Given a working endpoint that omits all usage fields.
    relay.mode = 'missing-usage';
    // When two model requests complete successfully.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model' },
        apiKey: 'usage-key',
        probes: ['structured_output'],
      },
      { networkPolicy: 'local' }
    );
    // Then unreported amounts remain null and coverage records the missing responses.
    expect(report.usage).toMatchObject({
      tokens: {
        inputTokens: null,
        outputTokens: null,
        modelRequests: 2,
        inputReportedRequests: 0,
        outputReportedRequests: 0,
      },
    });
  });

  it('user retains consumption in completed website steps and the final adapter result', async () => {
    // Given the adapter used by LMSpeed to save progress and final results.
    const snapshots: unknown[] = [];
    // When the adapter completes both structured-output requests.
    const output = await runLmspeedAudit(
      { baseUrl, modelId: 'test-model', apiKey: 'usage-key' },
      {
        networkPolicy: 'local',
        stepIds: ['structured_output'],
        onStepComplete: async (partial) => {
          snapshots.push(JSON.parse(JSON.stringify(partial)));
        },
      }
    );
    // Then the exact same actual usage survives both persistence boundaries.
    expect(output).toMatchObject({
      tokenUsage: { inputTokens: 24, outputTokens: 8 },
    });
    expect(snapshots).toMatchObject([
      { tokenUsage: { inputTokens: 24, outputTokens: 8 } },
    ]);
  });
});
