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
const options = { networkPolicy: 'local' as const, pacingMs: 0 };

describe('user audits actual provider capabilities', () => {
  it.each(['openai', 'anthropic', 'responses'] as const)(
    'user verifies tool arguments and disabled-tool permissions over %s',
    async (protocol) => {
      // Given a protocol endpoint that honors tool selection without executing tools.
      const input = {
        target: { baseUrl, modelId: 'test-model', protocol },
        apiKey: 'local-test-credential',
        probes: ['tool_calling'],
      };
      // When the public audit performs forced and disabled calls.
      const report = await runAudit(input, options);
      // Then the capability is verified using both positive and negative controls.
      expect(report.probes[0]?.verdict).toBe('pass');
      expect(report.usage.requests).toBe(3);
      expect(report.probes[0]?.observations).toMatchObject({
        forcedValid: true,
        disabledHonored: true,
      });
    }
  );
  it.each(['invalid-args', 'ignored-tools', 'unauthorized-tool'])(
    'user sees a tool contract violation for %s',
    async (mode) => {
      // Given a relay that rewrites arguments, ignores selection or returns forbidden calls.
      relay.mode = mode;
      // When the user tests real tool calls.
      const report = await runAudit(
        {
          target: { baseUrl, modelId: 'test-model', protocol: 'openai' },
          apiKey: 'local-test-credential',
          probes: ['tool_calling'],
        },
        options
      );
      // Then the defect remains a finding rather than an ordinary text success.
      expect(report.probes[0]?.verdict).toBe('finding');
    }
  );
  it.each(['openai', 'responses'] as const)(
    'user tests strict schema enforcement over %s',
    async (protocol) => {
      // Given a real endpoint accepting a strict object schema.
      const input = {
        target: { baseUrl, modelId: 'test-model', protocol },
        apiKey: 'local-test-credential',
        probes: ['structured_output'],
      };
      // When both a valid and extra-field response are audited.
      const valid = await runAudit(input, options);
      relay.mode = 'extra-json';
      const invalid = await runAudit(input, options);
      // Then extra properties violate the declared strict contract.
      expect(valid.probes[0]?.verdict).toBe('pass');
      expect(invalid.probes[0]?.verdict).toBe('finding');
    }
  );
  it.each(['openai', 'anthropic', 'responses'] as const)(
    'user submits actual image bytes over %s',
    async (protocol) => {
      // Given an explicitly enabled image capability and a generated image.
      const input = {
        target: { baseUrl, modelId: 'test-model', protocol },
        apiKey: 'local-test-credential',
        probes: ['image_understanding'],
        capabilities: { vision: true },
      };
      // When the image answer is checked without placing the answer in the prompt.
      const report = await runAudit(input, options);
      // Then the endpoint demonstrates image-content access.
      expect(report.probes[0]?.verdict).toBe('pass');
      expect(report.probes[0]?.observations.mediaSubmitted).toBe(true);
    }
  );
  it.each(['anthropic', 'responses'] as const)(
    'user submits a complete generated PDF over %s',
    async (protocol) => {
      // Given an enabled PDF capability with a randomly generated document word.
      const input = {
        target: { baseUrl, modelId: 'test-model', protocol },
        apiKey: 'local-test-credential',
        probes: ['pdf_understanding'],
        capabilities: { pdf: true },
      };
      // When actual PDF bytes are sent to the endpoint.
      const report = await runAudit(input, options);
      // Then correctly reading the embedded word passes the capability test.
      expect(report.probes[0]?.verdict).toBe('pass');
      expect(report.probes[0]?.observations.mediaSubmitted).toBe(true);
    }
  );
  it('user retains all context positions and sees missing recall separately', async () => {
    // Given a bounded multi-position recall plan.
    const input = {
      target: { baseUrl, modelId: 'test-model', protocol: 'openai' as const },
      apiKey: 'local-test-credential',
      probes: ['context_recall'],
      context: { sizes: [512, 1024], positions: [0, 0.5, 1] },
    };
    // When a complete route and one dropping a fact are audited.
    const valid = await runAudit(input, options);
    relay.lostNeedle = true;
    const invalid = await runAudit(input, options);
    // Then recall failures are observable without claiming a relay caused them.
    expect(valid.probes[0]?.verdict).toBe('pass');
    expect(invalid.probes[0]?.verdict).toBe('finding');
    expect(invalid.probes[0]?.observations.attribution).toContain('not proof');
  });
  it.each(['openai', 'anthropic', 'responses'] as const)(
    'user compares streamed and non-streamed usage over %s',
    async (protocol) => {
      // Given identical deterministic requests with provider-reported usage.
      const input = {
        target: { baseUrl, modelId: 'test-model', protocol },
        apiKey: 'local-test-credential',
        probes: ['stream_consistency'],
      };
      // When normal and inconsistent metering are compared.
      const valid = await runAudit(input, options);
      relay.mode = 'usage-drift';
      const invalid = await runAudit(input, options);
      // Then reported token differences are flagged independently of answer identity.
      expect(valid.probes[0]?.verdict).toBe('pass');
      expect(invalid.findings.map((f) => f.code)).toContain(
        'stream_input_usage_mismatch'
      );
    }
  );
  it.each(['refusal', 'unexpected-stream'] as const)(
    'user sees %s classified without protocol retries',
    async (mode) => {
      // Given an endpoint returning a non-answer outcome with HTTP 200.
      relay.mode = mode;
      // When the user requests a capability check.
      const report = await runAudit(
        {
          target: { baseUrl, modelId: 'test-model', protocol: 'openai' },
          apiKey: 'local-test-credential',
          probes: ['structured_output'],
        },
        options
      );
      // Then the report records the actual outcome without an extra format attempt.
      expect(report.probes[0]?.verdict).toBe('inconclusive');
      expect(report.probes[0]?.observations.outcome).toBe(
        mode === 'refusal' ? 'safety_refusal' : 'unexpected_stream'
      );
      expect(relay.requests).toBe(1);
    }
  );
  it.each(['unsupported', 'unauthorized', 'missing-usage', 'truncated'])(
    'user does not receive a clean pass for %s',
    async (mode) => {
      // Given missing support, failed acquisition or an incomplete stream.
      relay.mode = mode;
      // When consistency is audited.
      const report = await runAudit(
        {
          target: { baseUrl, modelId: 'test-model', protocol: 'anthropic' },
          apiKey: 'local-test-credential',
          probes: ['stream_consistency'],
        },
        options
      );
      // Then incomplete evidence stays distinct from verified behavior.
      expect(report.probes[0]?.verdict).toBe('inconclusive');
    }
  );
  it('user does not spend requests on media without an explicit capability', async () => {
    // Given an unknown PDF capability.
    const input = {
      target: { baseUrl, modelId: 'test-model' },
      apiKey: 'local-test-credential',
      probes: ['pdf_understanding', 'image_understanding'],
    };
    // When the user executes the selection.
    const report = await runAudit(input, options);
    // Then unsupported coverage is explicit and no media calls are billed.
    expect(report.coverage.unsupported).toEqual([
      'pdf_understanding',
      'image_understanding',
    ]);
    expect(relay.requests).toBe(0);
  });
});
