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
function input(probes: string[]) {
  return {
    target: { baseUrl, modelId: 'test-model', protocol: 'openai' as const },
    apiKey: 'local-test-credential',
    probes,
  };
}

describe('user receives conservative evidence from controlled checks', () => {
  it.each([true, false])(
    'user receives only valid auxiliary judge evidence (valid=%s)',
    async (valid) => {
      // Given separate reference and judge routes, with a weak target explanation.
      const reference = new FeatureRelay();
      const referenceUrl = await reference.start();
      relay.mode = 'subjective-degraded';
      if (!valid) reference.mode = 'invalid-judge';
      try {
        // When the explicit judge evaluates randomly ordered anonymous answers.
        const report = await runAudit(
          {
            ...input(['quality_comparison']),
            reference: {
              target: {
                baseUrl: referenceUrl,
                modelId: 'reference-model',
                protocol: 'openai',
              },
              apiKey: 'reference-private-key',
            },
            judge: {
              target: {
                baseUrl: referenceUrl,
                modelId: 'judge-model',
                protocol: 'openai',
              },
              apiKey: 'judge-private-key',
            },
          },
          options
        );
        // Then score attribution survives blinding and malformed judging cannot be a quality signal.
        expect(report.probes[0]?.observations.judge).toMatchObject(
          valid
            ? { valid: true, targetScore: 2, referenceScore: 9 }
            : { valid: false }
        );
        expect(
          report.findings.some((f) => f.code === 'judge_quality_signal')
        ).toBe(valid);
        expect(report.probes[0]?.verdict).toBe(
          valid ? 'finding' : 'inconclusive'
        );
        expect(JSON.stringify(report)).not.toContain('judge-private-key');
        expect(report.usage.requests).toBe(33);
      } finally {
        await reference.close();
      }
    }
  );
  it('user detects calls to tools that were never declared', async () => {
    // Given a relay that invents call records even when no tool is declared.
    relay.mode = 'undeclared-tool';
    // When the user audits tool permissions.
    const report = await runAudit(input(['tool_calling']), options);
    // Then an undeclared tool call is a hard contract violation.
    expect(report.findings.map((f) => f.code)).toContain(
      'undeclared_tool_call_returned'
    );
  });
  it('user verifies changing strict constraints instead of a fixed answer', async () => {
    // Given a relay honoring two independently randomized schemas.
    const request = input(['structured_output']);
    // When the user tests the strict output contract.
    const report = await runAudit(request, options);
    // Then two opposite boolean constraints are each verified.
    expect(report.probes[0]?.observations).toMatchObject({
      valid: true,
      trials: [
        { expectedOk: true, valid: true },
        { expectedOk: false, valid: true },
      ],
    });
  });
  it('user does not accept an endpoint ignoring strict output parameters', async () => {
    // Given a relay dropping schema parameters.
    relay.mode = 'ignore-schema';
    // When the user submits the contract probe.
    const report = await runAudit(input(['structured_output']), options);
    // Then generic text cannot be accepted as structured output.
    expect(report.probes[0]?.verdict).toBe('finding');
  });
  it('user does not attribute a single recall miss to truncation', async () => {
    // Given one transient missed fact followed by successful recall.
    relay.lostNeedleOnce = true;
    // When the user confirms recall at a bounded context length.
    const report = await runAudit(
      { ...input(['context_recall']), context: { sizes: [512] } },
      options
    );
    // Then unstable recall is inconclusive instead of confirmed failure.
    expect(report.probes[0]?.verdict).toBe('inconclusive');
    expect(report.findings).toEqual([]);
    expect(report.usage.requests).toBe(2);
  });
  it('user receives objective quality results and sees degradation', async () => {
    // Given an endpoint solving the deterministic task set.
    const request = input(['quality_canary']);
    // When normal and degraded responses are audited.
    const normal = await runAudit(request, options);
    relay.degraded = true;
    const degraded = await runAudit(request, options);
    // Then the result reports answer correctness without asserting identity.
    expect(normal.probes[0]?.observations).toMatchObject({
      correct: 10,
      scheduled: 10,
      acquired: 10,
    });
    expect(normal.probes[0]?.verdict).toBe('pass');
    expect(degraded.probes[0]?.verdict).toBe('finding');
    expect(degraded.probes[0]?.observations.correct).toBe(7);
  });
  it('user sees failed acquisition separated from quality scores', async () => {
    // Given a safety refusal rather than an answer.
    relay.mode = 'refusal';
    // When the deterministic task plan runs.
    const report = await runAudit(input(['quality_canary']), options);
    // Then unavailable answers remain outside the answer-quality denominator.
    expect(report.probes[0]?.observations).toMatchObject({
      acquired: 0,
      correct: 0,
      scheduled: 10,
    });
    expect(report.probes[0]?.verdict).toBe('inconclusive');
  });
  it('user detects quality loss against a trusted reference through paired tasks', async () => {
    // Given a separate healthy reference and a degraded tested route.
    const reference = new FeatureRelay();
    const referenceUrl = await reference.start();
    relay.degraded = true;
    try {
      // When the user compares identical tasks across both routes.
      const report = await runAudit(
        {
          ...input(['quality_comparison']),
          reference: {
            target: {
              baseUrl: referenceUrl,
              modelId: 'test-model',
              protocol: 'openai',
            },
            apiKey: 'reference-test-key',
          },
        },
        options
      );
      // Then paired regressions are reported without mixing acquisition failures.
      expect(report.probes[0]?.verdict).toBe('finding');
      expect(report.probes[0]?.observations).toMatchObject({
        paired: 10,
        regressions: 3,
        improvements: 0,
      });
      expect(report.usage.requests).toBe(30);
    } finally {
      await reference.close();
    }
  });
  it('user confirms conditional secret-disclosure signals with balanced controls', async () => {
    // Given a route that redirects decoy secrets only for financial tasks.
    relay.conditional = true;
    // When ordinary and sensitive paired tasks are tested repeatedly.
    const report = await runAudit(input(['conditional_injection']), options);
    // Then repeated direct disclosure is distinguished from ordinary answer variation.
    expect(report.probes[0]?.verdict).toBe('finding');
    expect(report.probes[0]?.observations).toMatchObject({
      ordinaryAnomalies: 0,
      sensitiveAnomalies: 3,
      pairs: 3,
    });
  });
  it('user never interprets safety refusals as conditional injection', async () => {
    // Given a route refusing every paired task.
    relay.mode = 'refusal';
    // When the user requests a conditional-injection check.
    const report = await runAudit(input(['conditional_injection']), options);
    // Then refusal remains incomplete evidence rather than an exfiltration finding.
    expect(report.probes[0]?.verdict).toBe('inconclusive');
    expect(report.findings).toEqual([]);
  });
  it('user shares one request budget across reference and target calls', async () => {
    // Given target and reference work under a three-request budget.
    const request = {
      ...input(['quality_comparison']),
      reference: {
        target: { baseUrl, modelId: 'test-model' },
        apiKey: 'reference-test-key',
      },
    };
    // When the paired plan runs with the shared cap.
    const report = await runAudit(request, {
      ...options,
      limits: { maxRequests: 3 },
    });
    // Then budget exhaustion is visible and no extra requests reach the endpoint.
    expect(report.usage.requests).toBe(3);
    expect(relay.requests).toBe(3);
    expect(report.probes[0]?.verdict).toBe('inconclusive');
  });
});
