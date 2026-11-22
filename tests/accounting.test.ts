import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAudit } from '../src/index.js';
import { reportedUsage } from '../src/protocols/completion.js';
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
const options = { networkPolicy: 'local' as const, pacingMs: 0 };
const baselines = (n: number) => ({
  plain: n,
  system: n,
  question: n,
});

describe('user compares reported usage without asserting hidden text or billing fraud', () => {
  it('user does not replace explicitly unknown cache usage with zero', () => {
    // Given a Messages response explicitly reporting an unknown cache-read count.
    const usage = {
      input_tokens: 12,
      cache_read_input_tokens: null,
      output_tokens: 4,
    };
    // When reported input is normalized.
    const reported = reportedUsage(usage, 'anthropic');
    // Then optional absent fields may be zero, while an explicit unknown prevents a total.
    expect(reported).toMatchObject({
      ordinary: 12,
      cacheRead: null,
      cacheWrite: 0,
      total: null,
    });
  });
  it.each(['openai', 'anthropic', 'responses'] as const)(
    'user counts cached input exactly once over %s',
    async (protocol) => {
      // Given ten ordinary tokens plus 150 cached tokens in a Messages-style accounting model.
      relay.cached = true;
      // When the calibrated total of 160 is checked over each API format.
      const report = await runAudit(
        {
          target: { baseUrl, modelId: 'test-model', protocol },
          apiKey: 'local-test-credential',
          probes: ['token_injection'],
          capabilities: { tokenBaselines: baselines(160) },
        },
        options
      );
      // Then cache fields are preserved and total usage matches the calibration.
      expect(report.probes[0]?.verdict).toBe('pass');
      expect(report.probes[0]?.observations.trials).toEqual([
        { id: 'plain', expected: 160, reported: 160 },
        { id: 'system', expected: 160, reported: 160 },
        { id: 'question', expected: 160, reported: 160 },
      ]);
    }
  );
  it('user sees surplus as reported usage evidence rather than proof of prompt injection', async () => {
    // Given reported cached input higher than a supplied total calibration.
    relay.cached = true;
    // When usage is compared with the calibrated request template.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model', protocol: 'anthropic' },
        apiKey: 'local-test-credential',
        probes: ['token_injection'],
        capabilities: { tokenBaselines: baselines(10) },
      },
      options
    );
    // Then the finding retains the measured difference without claiming its cause.
    expect(report.probes[0]?.verdict).toBe('finding');
    expect(report.findings[0]?.evidence).toContain('reported 160');
    expect(report.probes[0]?.observations.scope).toContain(
      'no hidden-prompt or billing attribution'
    );
  });
  it.each(['refusal', 'unexpected-stream'])(
    'user records %s once per logical request without format fallback',
    async (mode) => {
      // Given an HTTP 200 non-answer outcome on an auto-format endpoint.
      relay.mode = mode;
      // When a calibrated usage request cannot acquire an answer.
      const report = await runAudit(
        {
          target: { baseUrl, modelId: 'test-model', protocol: 'auto' },
          apiKey: 'local-test-credential',
          probes: ['token_injection'],
          capabilities: { tokenBaselines: baselines(12) },
        },
        options
      );
      // Then the original outcome is visible and never treated as a need to retry another protocol.
      expect(relay.requests).toBe(1);
      expect(report.probes[0]?.observations.outcome).toBe(
        mode === 'refusal' ? 'safety_refusal' : 'unexpected_stream'
      );
      expect(report.probes[0]?.verdict).toBe('inconclusive');
    }
  );
  it('user preserves unknown usage rather than interpreting it as zero', async () => {
    // Given an acquired response with no metering fields.
    relay.mode = 'missing-usage';
    // When input usage is compared with a supplied baseline.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model', protocol: 'openai' },
        apiKey: 'local-test-credential',
        probes: ['token_injection'],
        capabilities: { tokenBaselines: baselines(12) },
      },
      options
    );
    // Then a missing measurement cannot become a clean comparison.
    expect(report.probes[0]?.verdict).toBe('inconclusive');
    expect(report.findings).toEqual([]);
  });
});
