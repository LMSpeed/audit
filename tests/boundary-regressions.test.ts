import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  calibrateFingerprint,
  rankDistributions,
} from '../src/identity/distribution.js';
import { collectFingerprintBaseline, runAudit } from '../src/index.js';
import { parseCompletionStream } from '../src/protocols/completion.js';
import type { FingerprintBaseline } from '../src/schema/index.js';
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

describe('user retains conservative evidence at protocol and collection boundaries', () => {
  it.each([
    'invalid-tool-type',
    'invalid-tool-finish',
    'legacy-forbidden-tool',
  ])('user cannot receive a tool pass for %s', async (mode) => {
    // Given valid-looking arguments inside an invalid or forbidden call record.
    relay.mode = mode;
    // When the full tool contract is checked.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model', protocol: 'openai' },
        apiKey: 'private-regression-key',
        probes: ['tool_calling'],
      },
      { networkPolicy: 'local' }
    );
    // Then malformed records cannot become a verified tool capability.
    expect(report.probes[0]?.verdict).toBe('finding');
    if (mode !== 'legacy-forbidden-tool')
      expect(report.probes[0]?.observations.forcedValid).toBe(false);
  });
  it('user does not persist credentials echoed into reference answers', async () => {
    // Given a source echoing its authentication key into the answer.
    relay.mode = 'credential-echo';
    // When independent reference batches are collected.
    const collected = await collectFingerprintBaseline(
      {
        contract: {
          protocol: 'openai',
          prompts: ['Choose color.', 'Choose animal.'],
          generation: { maxOutputTokens: 128 },
          samplesPerPrompt: 16,
        },
        sources: ['a', 'b', 'other'].map((id) => ({
          id,
          kind: id === 'other' ? 'other' : 'candidate',
          target: { baseUrl, modelId: id, protocol: 'openai' },
          apiKey: `private-${id}-key`,
        })),
      },
      { networkPolicy: 'local' }
    );
    // Then the artifact rejects the samples and excludes all source credentials.
    expect(JSON.stringify(collected)).not.toContain('private-a-key');
    expect(collected.baseline.calibration.status).toBe('insufficient');
    expect(
      collected.failures.some((f) => f.outcome === 'credential_echo')
    ).toBe(true);
  });
  it.each(['openai', 'anthropic'] as const)(
    'user retains earlier metering when a late %s event contains null fields',
    (protocol) => {
      // Given valid initial usage followed by nullable late-event fields.
      const events =
        protocol === 'openai'
          ? [
              {
                model: 'model',
                usage: {
                  prompt_tokens: 12,
                  completion_tokens: 4,
                  prompt_tokens_details: { cached_tokens: 3 },
                },
                choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
              },
              {
                usage: {
                  prompt_tokens: null,
                  prompt_tokens_details: { cached_tokens: null },
                },
                choices: [],
              },
            ]
          : [
              {
                type: 'message_start',
                message: {
                  model: 'model',
                  usage: { input_tokens: 12, cache_read_input_tokens: 3 },
                },
              },
              {
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: 'ok' },
              },
              {
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: {
                  input_tokens: null,
                  cache_read_input_tokens: null,
                  output_tokens: 4,
                },
              },
              { type: 'message_stop' },
            ];
      // When the complete stream is parsed.
      const parsed = parseCompletionStream(
        events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') +
          (protocol === 'openai' ? 'data: [DONE]\n\n' : ''),
        protocol
      );
      // Then absent late values cannot erase earlier valid measurements.
      expect(parsed.outcome).toBe('answer');
      expect(parsed.usage.total).toBe(protocol === 'openai' ? 12 : 15);
      expect(parsed.usage.cacheRead).toBe(3);
    }
  );
  it('user can compare answer categories named after inherited object properties', () => {
    // Given a legitimate observed category absent from one reference.
    const baseline: Pick<FingerprintBaseline, 'sources' | 'contract'> = {
      contract: {
        protocol: 'openai' as const,
        prompts: ['a', 'b'],
        generation: { maxOutputTokens: 128 },
        samplesPerPrompt: 16,
      },
      sources: [
        {
          id: 'a',
          kind: 'candidate' as const,
          training: [{ constructor: 16 }, { toString: 16 }],
          validation: [],
        },
        {
          id: 'b',
          kind: 'candidate' as const,
          training: [{ red: 16 }, { blue: 16 }],
          validation: [],
        },
      ],
    };
    // When the category is ranked against both references.
    const ranking = rankDistributions(baseline, [
      { constructor: 16 },
      { toString: 16 },
    ]);
    // Then all scores are finite and ordinary categories retain their ordering.
    expect(ranking.every((row) => Number.isFinite(row.logLikelihood))).toBe(
      true
    );
    expect(ranking[0]?.id).toBe('a');
  });
  it('user can roundtrip an incomplete calibration without losing numeric semantics', () => {
    // Given empty acquisition cells after exhausted collection budget.
    const baseline: Pick<FingerprintBaseline, 'sources' | 'contract'> = {
      contract: {
        protocol: 'openai' as const,
        prompts: ['a', 'b'],
        generation: { maxOutputTokens: 128 },
        samplesPerPrompt: 16,
      },
      sources: ['a', 'b', 'other'].map((id) => ({
        id,
        kind: id === 'other' ? ('other' as const) : ('candidate' as const),
        training: [{}, {}],
        validation: [{}, {}],
      })),
    };
    // When the calibration is serialized for later inspection.
    const calibration = calibrateFingerprint(baseline);
    // Then unavailable thresholds are explicitly nullable rather than non-JSON infinities.
    expect(calibration.minimumLogLikelihood.a).toBeNull();
    expect(JSON.parse(JSON.stringify(calibration))).toEqual(calibration);
  });
});
