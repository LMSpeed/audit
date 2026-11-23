import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAudit } from '../src/index.js';
import { object } from '../src/protocols/completion.js';
import { FeatureRelay } from './feature-relay.js';

let relay: FeatureRelay;
let baseUrl: string;
beforeEach(async () => {
  relay = new FeatureRelay();
  baseUrl = await relay.start();
});
afterEach(async () => relay.close());
const options = { networkPolicy: 'local' as const };
const input = (
  probes: string[],
  protocol = 'openai' as 'openai' | 'anthropic' | 'responses'
) => ({
  target: { baseUrl, modelId: 'test-model', protocol },
  apiKey: 'evidence-private-credential',
  probes,
});
const exchanges = (observations: Record<string, unknown>) =>
  (object(observations.requestEvidence).exchanges ?? []) as Array<
    Record<string, unknown>
  >;

describe('user can verify the requests behind an audit judgment', () => {
  it.each(['openai', 'anthropic', 'responses'] as const)(
    'user sees actual prompts parameters schema and answer for %s',
    async (protocol) => {
      // Given a real HTTP protocol fixture with deterministic task answers and strict schemas.
      // When the user runs quality and structured-output checks.
      const report = await runAudit(
        {
          ...input(['quality_canary', 'structured_output'], protocol),
          generation: { temperature: 0, maxOutputTokens: 80 },
        },
        options
      );
      // Then the report retains exact wire data and the expected answer used by the evaluator.
      const quality = report.probes[0]!.observations;
      const first = exchanges(quality)[0]!;
      expect(first).toMatchObject({
        request: {
          method: 'POST',
          body: { model: 'test-model', temperature: 0 },
        },
        response: {
          status: 200,
          completion: { text: '391', outcome: 'answer' },
        },
      });
      expect(JSON.stringify(first)).toContain(
        'Compute 17 * 23. Reply with the integer only.'
      );
      expect(
        (quality.trials as Array<Record<string, unknown>>)[0]
      ).toMatchObject({
        prompt: 'Compute 17 * 23. Reply with the integer only.',
        expected: '391',
        response: '391',
        correct: true,
      });
      const schema = exchanges(report.probes[1]!.observations);
      expect(schema).toHaveLength(2);
      expect(JSON.stringify(schema[1])).toContain('additionalProperties');
      expect(
        (
          report.probes[1]!.observations.trials as Array<
            Record<string, unknown>
          >
        )[1]
      ).toMatchObject({ expected: { ok: false }, valid: true });
      expect(report.usage.requests).toBe(12);
    }
  );

  it('user sees only the corresponding request for each security subcheck', async () => {
    // Given randomized protected values in system prompts.
    // When extraction challenges run over the Anthropic protocol.
    const report = await runAudit(
      input(['prompt_extraction'], 'anthropic'),
      options
    );
    // Then every challenge preserves its own system and user prompt without unrelated exchanges.
    for (const check of report.probes[0]!.checks!) {
      const saved = exchanges(check.observations);
      expect(saved).toHaveLength(1);
      expect(
        (
          object(object(saved[0]!.request).body).messages as Array<
            Record<string, unknown>
          >
        )[0]!.content
      ).toBe(check.observations.userPrompt);
      if (check.observations.controlled)
        expect(object(object(saved[0]!.request).body).system).toBe(
          check.observations.systemPrompt
        );
    }
  });

  it('user receives complete ordinary responses and parsed SSE without exposing authentication', async () => {
    // Given an endpoint echoing the credential in both ordinary and SSE answers.
    relay.mode = 'credential-echo';
    // When streamed and plain requests are compared.
    const report = await runAudit(input(['stream_consistency']), options);
    // Then actual stream frames and decoded answers survive while all credential copies are redacted.
    const saved = exchanges(report.probes[0]!.observations);
    expect(saved).toHaveLength(2);
    expect(saved[1]).toMatchObject({
      response: {
        contentType: 'text/event-stream',
        completion: { text: '[redacted-key]' },
      },
    });
    expect(JSON.stringify(saved[1])).toContain('[DONE]');
    expect(JSON.stringify(report)).not.toContain(input([]).apiKey);
    expect(JSON.stringify(saved)).not.toMatch(/authorization|x-api-key/i);
  });

  it('user can distinguish abbreviated long context from a complete request', async () => {
    // Given automatic expansion up to the bounded context-search maximum.
    // When the user inspects the largest submitted prompt.
    const report = await runAudit(
      {
        ...input(['context_window']),
        contextSearch: { maximumCharacters: 524288 },
      },
      options
    );
    // Then the prompt has explicit length, digest and excerpts, and the expected markers remain recorded.
    const saved = exchanges(report.probes[0]!.observations);
    const body = object(object(saved.at(-1)!.request).body);
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]!.content).toMatchObject({
      truncated: true,
      characters: 524288,
      sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      head: expect.stringContaining('FACT_'),
      tail: expect.stringContaining('Return only a JSON array'),
    });
    const trials = report.probes[0]!.observations.trials as Array<
      Record<string, unknown>
    >;
    expect(trials.at(-1)!.expectedMarkers).toHaveLength(5);
    expect(JSON.stringify(report).length).toBeLessThan(200000);
  });

  it('user retains the failed request and HTTP error instead of an empty output', async () => {
    // Given a relay denying authentication.
    relay.mode = 'unauthorized';
    // When a quality request is rejected.
    const report = await runAudit(input(['quality_canary']), options);
    // Then the actual error body and submitted prompt remain available for diagnosis.
    expect(exchanges(report.probes[0]!.observations)[0]).toMatchObject({
      response: { status: 401, body: { error: { message: 'invalid key' } } },
    });
    expect(JSON.stringify(exchanges(report.probes[0]!.observations))).toContain(
      'Compute 17 * 23'
    );
    expect(report.probes[0]!.verdict).toBe('inconclusive');
  });
});
