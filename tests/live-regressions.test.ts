import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

describe('user avoids format and reasoning false positives revealed by live validation', () => {
  it('user recovers facts returned in a fenced JSON block', async () => {
    // Given correctly recalled facts wrapped in a Markdown code block.
    relay.mode = 'fenced-recall';
    // When recall is measured independently of the strict-output probe.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model', protocol: 'anthropic' },
        apiKey: 'live-regression-key',
        probes: ['context_recall'],
        context: { sizes: [512], positions: [0, 0.5, 1] },
      },
      { networkPolicy: 'local' }
    );
    // Then complete recall passes without issuing a needless confirmation request.
    expect(report.probes[0]?.verdict).toBe('pass');
    expect(report.usage.requests).toBe(1);
    expect(report.probes[0]?.observations.trials).toMatchObject([
      {
        format: 'text_markers',
        recalled: [{ found: true }, { found: true }, { found: true }],
      },
    ]);
  });
  it('user still detects missing facts inside a fenced JSON block', async () => {
    // Given a formatted response that consistently omits one actual fact.
    relay.mode = 'fenced-recall';
    relay.lostNeedle = true;
    // When recall is confirmed twice.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model', protocol: 'anthropic' },
        apiKey: 'live-regression-key',
        probes: ['context_recall'],
        context: { sizes: [512] },
      },
      { networkPolicy: 'local' }
    );
    // Then formatting tolerance does not hide a genuine missing marker.
    expect(report.probes[0]?.verdict).toBe('finding');
    expect(report.usage.requests).toBe(2);
  });
  it.each(['openai', 'responses', 'anthropic'] as const)(
    'user excludes variable hidden reasoning from output comparison over %s',
    async (protocol) => {
      // Given identical text with totals 11/8, reasoning 9/6 and non-reasoning output 2/2.
      relay.mode = 'reasoning-usage';
      // When streamed and ordinary output usage is compared.
      const report = await runAudit(
        {
          target: { baseUrl, modelId: 'test-model', protocol },
          apiKey: 'live-regression-key',
          probes: ['stream_consistency'],
        },
        { networkPolicy: 'local' }
      );
      // Then different reasoning lengths cannot create an output-metering finding.
      expect(report.probes[0]?.verdict).toBe('pass');
      expect(report.probes[0]?.observations).toMatchObject({
        plain: { usage: { output: 11, reasoning: 9, nonReasoningOutput: 2 } },
        streamed: { usage: { output: 8, reasoning: 6, nonReasoningOutput: 2 } },
      });
    }
  );
  it('user abstains on output-count differences without a reasoning breakdown', async () => {
    // Given identical text and different totals with no hidden-output measurement.
    relay.mode = 'unknown-output-drift';
    // When the user compares streamed and ordinary requests.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model', protocol: 'openai' },
        apiKey: 'live-regression-key',
        probes: ['stream_consistency'],
      },
      { networkPolicy: 'local' }
    );
    // Then unknown reasoning is retained rather than assumed zero.
    expect(report.probes[0]?.verdict).toBe('inconclusive');
    expect(report.findings).toEqual([]);
  });
  it('user retains a count difference after explicitly measured reasoning is removed', async () => {
    // Given different output totals and explicit zero reasoning on both responses.
    relay.mode = 'nonreasoning-output-drift';
    // When the comparable non-reasoning counts are checked.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model', protocol: 'openai' },
        apiKey: 'live-regression-key',
        probes: ['stream_consistency'],
      },
      { networkPolicy: 'local' }
    );
    // Then a real reported difference remains reviewable.
    expect(report.findings.map((f) => f.code)).toContain(
      'stream_output_usage_mismatch'
    );
  });
});
