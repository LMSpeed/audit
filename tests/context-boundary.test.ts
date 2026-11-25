import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAudit } from '../src/index.js';
import { getAuditAssessmentMessage } from '../src/probes/assessment.js';
import type { AuditInput } from '../src/schema/index.js';
import { FeatureRelay } from './feature-relay.js';

let relay: FeatureRelay;
let baseUrl: string;
beforeEach(async () => {
  relay = new FeatureRelay();
  baseUrl = await relay.start();
});
afterEach(async () => relay.close());
const input = (): AuditInput => ({
  target: { baseUrl, modelId: 'test-model', protocol: 'openai' },
  apiKey: 'context-regression-key',
  probes: ['context_window'],
});
const options = { networkPolicy: 'local' as const };

describe('user measures context admission separately from long-input recall', () => {
  it('user runs a single fixed-length sample when both context modes are selected', async () => {
    // Given a fixed sample length and no published context reference.
    const auditInput = {
      ...input(),
      probes: ['context_recall', 'context_window'],
      context: { sizes: [512] },
    };
    // When the user selects both context modes in one audit.
    const report = await runAudit(auditInput, {
      ...options,
      probeConcurrency: 2,
    });
    // Then the report keeps one context result and charges one model request.
    expect(report.coverage.requested).toEqual(['context_window']);
    expect(report.usage.requests).toBe(1);
    expect(report.probes[0]).toMatchObject({
      id: 'context_window',
      observations: {
        trials: [{ size: 512 }],
        contextVerification: { reason: 'reference_missing' },
      },
    });
  });

  it('user sees which positions were recalled in the same sample that verifies the input limit', async () => {
    // Given a published window and an endpoint that drops the first marker at large input sizes.
    relay.contextTokensPerCharacter = 0.65;
    relay.recallLimit = 20000;
    const auditInput = {
      ...input(),
      probes: ['context_window', 'context_recall'],
      capabilities: { contextWindowTokens: 32000 },
    };
    // When the user checks the context window and recall together.
    const report = await runAudit(auditInput, options);
    // Then the near-limit sample reports input admission and exactly which position was missed.
    expect(report.probes).toHaveLength(1);
    expect(report.usage.requests).toBe(3);
    expect(report.probes[0]?.observations).toMatchObject({
      contextVerification: { verdict: 'fail', reason: 'recall_missing' },
      trials: expect.arrayContaining([
        expect.objectContaining({
          accepted: true,
          recalled: false,
          markerRecall: [
            { position: 0, found: false },
            { position: 0.25, found: true },
            { position: 0.5, found: true },
            { position: 0.75, found: true },
            { position: 1, found: true },
          ],
        }),
      ]),
    });
  });

  it('user gets a measured boundary after a temporary upstream disconnect', async () => {
    // Given a relay that drops the first long request and enforces its context limit after reconnecting.
    relay.disconnectAbove = 50000;
    relay.disconnectsRemaining = 1;
    relay.contextLimit = 100000;
    // When the context search grows beyond the first successful sample.
    const report = await runAudit(input(), options);
    // Then the report records both outcomes at that size and locates the admission interval.
    expect(report.probes[0]!.observations).toMatchObject({
      largestAcceptedCharacters: expect.any(Number),
      smallestRejectedCharacters: expect.any(Number),
      stopReason: 'boundary_located',
      trials: expect.arrayContaining([
        expect.objectContaining({ size: 65536, status: 0, rejected: false }),
        expect.objectContaining({ size: 65536, status: 200, recalled: true }),
      ]),
    });
  });
  it('user retains the lower bound when an upstream disconnect persists', async () => {
    // Given a relay that drops every request after the first successful size.
    relay.disconnectAbove = 50000;
    relay.disconnectsRemaining = Number.POSITIVE_INFINITY;
    // When the context search encounters repeated disconnects.
    const report = await runAudit(input(), options);
    // Then it stops after one retry and keeps the accepted sample and both disconnects.
    expect(report.probes[0]!.observations).toMatchObject({
      largestAcceptedCharacters: 32768,
      smallestRejectedCharacters: null,
      stopReason: 'request_failed',
      trials: [
        expect.objectContaining({ size: 32768, status: 200 }),
        expect.objectContaining({ size: 65536, status: 0 }),
        expect.objectContaining({ size: 65536, status: 0 }),
      ],
    });
  });
  it('user keeps the audit request budget when a disconnect consumes the last request', async () => {
    // Given a relay that drops the second request and an audit budget of two requests.
    relay.disconnectAbove = 50000;
    relay.disconnectsRemaining = 1;
    // When the context search tries to recover from the disconnect.
    const report = await runAudit(input(), {
      ...options,
      limits: { maxRequests: 2 },
    });
    // Then the report retains the first sample and identifies the exhausted budget.
    expect(report.probes[0]!.observations).toMatchObject({
      largestAcceptedCharacters: 32768,
      smallestRejectedCharacters: null,
      stopReason: 'budget_exhausted',
    });
  });
  it('user gets a tighter verified lower bound after an ambiguous HTTP 400', async () => {
    // Given a gateway that returns a generic invalid request above 100000 characters.
    relay.invalidRequestAbove = 100000;
    // When the next doubled sample crosses that threshold.
    const report = await runAudit(input(), options);
    // Then smaller probes raise the verified lower bound without claiming a context limit.
    expect(report.probes[0]!.observations).toMatchObject({
      largestAcceptedCharacters: 98304,
      capacityStatus: 'lower_bound',
      smallestRejectedCharacters: null,
      upperBoundObserved: false,
      searchComplete: false,
      stopReason: 'request_failed',
      status: 400,
      reason: 'invalid_request_error',
      trials: expect.arrayContaining([
        expect.objectContaining({ size: 131072, status: 400, rejected: false }),
        expect.objectContaining({ size: 98304, status: 200, recalled: true }),
      ]),
    });
  });
  it('user can still verify an explicit context boundary below an ambiguous HTTP 400', async () => {
    // Given a gateway that masks the context error only for larger requests.
    relay.invalidRequestAbove = 120000;
    relay.contextLimit = 90000;
    // When the scan refines the gap after the generic error.
    const report = await runAudit(input(), options);
    const observed = report.probes[0]!.observations;
    // Then only the confirmed context error supplies an upper bound.
    expect(observed).toMatchObject({
      capacityStatus: 'bounded',
      stopReason: 'boundary_located',
      searchComplete: true,
    });
    expect(observed.largestAcceptedCharacters).toBeGreaterThan(86000);
    expect(observed.smallestRejectedCharacters).toBeLessThanOrEqual(94000);
  });
  it('user keeps the context request cap during ambiguous error refinement', async () => {
    // Given a generic rejection after the first sample and a cap of three requests.
    relay.invalidRequestAbove = 54000;
    // When the scan can afford only one intermediate sample.
    const report = await runAudit(
      { ...input(), contextSearch: { maximumRequests: 3 } },
      options
    );
    // Then the accepted midpoint is retained and the report identifies the budget cap.
    expect(report.probes[0]!.observations).toMatchObject({
      largestAcceptedCharacters: 49152,
      smallestRejectedCharacters: null,
      stopReason: 'request_limit',
    });
  });
  it('user retains the accepted sample when a gateway rejects the HTTP payload', async () => {
    // Given an HTTP payload limit above the first sample.
    relay.payloadLimit = 50000;
    // When the scan grows beyond that payload limit.
    const report = await runAudit(input(), options);
    const observed = report.probes[0]!.observations;
    // Then the API acceptance lower bound and the payload failure are retained.
    expect(observed).toMatchObject({
      largestAcceptedCharacters: 32768,
      smallestRejectedCharacters: null,
      stopReason: 'payload_limit',
    });
    expect(getAuditAssessmentMessage(observed, 'en')).toContain('lower bound');
  });
  it('user does not mistake a reached test cap for a measured model ceiling', async () => {
    // Given an endpoint accepting every tested length.
    // When automatic context measurement reaches its configured scan cap.
    const report = await runAudit(
      { ...input(), contextSearch: { maximumCharacters: 1048576 } },
      options
    );
    const observed = report.probes[0]!.observations;
    // Then the result remains a lower bound, and the scan continues beyond the previous 524288-character cap.
    expect(Number(observed.largestAcceptedCharacters)).toBeGreaterThan(524288);
    expect(observed.upperBoundObserved).toBe(false);
    expect(observed.searchComplete).toBe(false);
    expect(observed.contextVerification).toMatchObject({
      verdict: 'fail',
      reason: 'reference_missing',
    });
    expect(report.probes[0]!.verdict).toBe('inconclusive');
  });
  it('user can still measure input admission when the model loses recall markers', async () => {
    // Given an endpoint accepting long input but consistently losing markers after 12000 characters.
    relay.recallLimit = 12000;
    // When automatic context measurement runs without a declared context size.
    const report = await runAudit(
      { ...input(), contextSearch: { maximumCharacters: 1048576 } },
      options
    );
    const observed = report.probes[0]!.observations;
    // Then recall loss is retained as separate evidence and cannot become a context rejection ceiling.
    expect(Number(observed.largestAcceptedCharacters)).toBeGreaterThan(524288);
    expect(observed.smallestRejectedCharacters).toBeNull();
    expect(observed.upperBoundObserved).toBe(false);
    expect(observed.recallStatus).toBe('loss_observed');
    expect(report.findings.map((finding) => finding.code)).toContain(
      'context_recall_missing'
    );
  });
  it('user verifies the advertised context with a short calibration and a targeted sample', async () => {
    // Given a 100,000-token model and an endpoint enforcing that same shared context budget.
    relay.contextTokensPerCharacter = 0.65;
    relay.contextTokenLimit = 100000;
    const target = input();
    target.capabilities = { contextWindowTokens: 100000 };
    // When the user audits the endpoint against the advertised specification.
    const report = await runAudit(target, options);
    // Then a few requests verify the near-limit input and the response recalls all markers.
    expect(report.probes[0]).toMatchObject({
      verdict: 'pass',
      observations: {
        reservedOutputTokens: 1024,
        contextVerification: {
          verdict: 'pass',
          targetInputTokens: 98976,
          reason: 'target_recalled',
        },
      },
    });
    expect(report.usage.requests).toBeLessThanOrEqual(3);
  });

  it.each(['openai', 'anthropic', 'responses'] as const)(
    'user can verify context without an extra request when the %s endpoint uses output tokens to reason',
    async (protocol) => {
      // Given a shared 32K window whose long requests use part of the output budget to reason.
      relay.contextTokensPerCharacter = 0.65;
      relay.contextTokenLimit = 32000;
      relay.contextRecallOutputTokens = 600;
      relay.contextRecallOutputRequiredAbove = 20000;
      const auditInput = {
        ...input(),
        target: { ...input().target, protocol },
        capabilities: { contextWindowTokens: 32000 },
      };
      // When the user verifies the advertised context.
      const report = await runAudit(auditInput, options);
      // Then both samples allow enough room for recall and the probe finishes after two requests.
      expect(report.probes[0]!.observations).toMatchObject({
        reservedOutputTokens: 1024,
        contextVerification: { verdict: 'pass', targetInputTokens: 30976 },
        trials: [
          expect.objectContaining({ recalled: true, maxOutputTokens: 1024 }),
          expect.objectContaining({ recalled: true, maxOutputTokens: 1024 }),
        ],
      });
      expect(report.usage.requests).toBe(2);
    }
  );

  it('user sees a failed verification when a smaller endpoint rejects the advertised target', async () => {
    // Given an endpoint capped at 80,000 tokens for a model advertised at 100,000 tokens.
    relay.contextTokensPerCharacter = 0.65;
    relay.contextTokenLimit = 80000;
    const target = {
      ...input(),
      capabilities: { contextWindowTokens: 100000 },
    };
    // When the user checks the advertised context.
    const report = await runAudit(target, options);
    // Then the endpoint cannot pass on shorter successful samples and the evidence keeps the rejection.
    expect(report.probes[0]!.observations).toMatchObject({
      contextVerification: { verdict: 'fail', targetInputTokens: 98976 },
      trials: expect.arrayContaining([
        expect.objectContaining({ status: 400, rejected: true }),
      ]),
    });
    expect(report.usage.requests).toBeLessThanOrEqual(5);
  });

  it('user can pass when the first targeted request slightly overshoots the published limit', async () => {
    // Given a matching endpoint where the long sample has denser tokenization than the calibration sample.
    relay.contextTokensPerCharacter = 0.65;
    relay.longContextTokenDensity = {
      above: 100000,
      tokensPerCharacter: 0.655,
    };
    relay.contextTokenLimit = 100000;
    const target = {
      ...input(),
      capabilities: { contextWindowTokens: 100000 },
    };
    // When an otherwise valid check encounters a slightly oversized input.
    const report = await runAudit(target, options);
    // Then a nearby sample verifies the advertised window within the same request budget.
    expect(report.probes[0]!.observations.contextVerification).toMatchObject({
      verdict: 'pass',
      reason: 'target_recalled',
    });
    expect(report.usage.requests).toBeLessThanOrEqual(5);
  });

  it('user verifies a published input cap without exceeding the official output cap', async () => {
    // Given a publisher that specifies separate input and output caps.
    relay.contextTokensPerCharacter = 0.65;
    relay.contextTokenLimit = 90400;
    const reportInput = {
      ...input(),
      contextReference: {
        modelId: 'test-model',
        contextWindowTokens: 100000,
        maxInputTokens: 90000,
        maxOutputTokens: 200,
        sourceUrl: 'https://publisher.example/model',
      },
    };
    // When the user verifies that model at the endpoint.
    const report = await runAudit(reportInput, options);
    // Then the probe verifies the published input cap and preserves the source and output budget.
    expect(report.probes[0]!.observations).toMatchObject({
      declaredContextWindowTokens: 100000,
      reservedOutputTokens: 200,
      contextVerification: {
        verdict: 'pass',
        targetInputTokens: 90000,
        sourceUrl: 'https://publisher.example/model',
      },
    });
  });

  it('user sees a failed verification when an accepted near-limit sample loses markers', async () => {
    // Given a correctly sized endpoint that consistently loses an early marker on long requests.
    relay.contextTokensPerCharacter = 0.65;
    relay.contextTokenLimit = 100000;
    relay.recallLimit = 100000;
    const target = {
      ...input(),
      capabilities: { contextWindowTokens: 100000 },
    };
    // When the endpoint accepts the targeted sample.
    const report = await runAudit(target, options);
    // Then accepting enough input by itself does not verify usable context.
    expect(report.probes[0]).toMatchObject({
      verdict: 'finding',
      observations: {
        contextVerification: { verdict: 'fail', reason: 'recall_missing' },
        recallStatus: 'loss_observed',
      },
    });
  });

  it('user cannot verify a target when token accounting does not grow with the request', async () => {
    // Given an endpoint that reports a low fixed token count for all input lengths.
    const target = {
      ...input(),
      capabilities: { contextWindowTokens: 100000 },
    };
    // When the user checks the advertised capacity.
    const report = await runAudit(target, options);
    // Then the check explicitly fails verification while keeping the accepted input evidence.
    expect(report.probes[0]!.observations).toMatchObject({
      contextVerification: { verdict: 'fail', reason: 'target_not_reached' },
      largestAcceptedInputTokens: 12,
    });
    expect(report.usage.requests).toBeLessThanOrEqual(5);
  });

  it('user cannot pass on a calibration sample with an inflated token count', async () => {
    // Given an endpoint whose short ASCII request reports several input tokens per character.
    relay.contextTokensPerCharacter = 10;
    const target = {
      ...input(),
      capabilities: { contextWindowTokens: 100000 },
    };
    // When the user checks the advertised capacity.
    const report = await runAudit(target, options);
    // Then the short sample cannot masquerade as a near-limit sample.
    expect(report.probes[0]!.observations.contextVerification).toMatchObject({
      verdict: 'fail',
      reason: 'token_usage_inconsistent',
    });
    expect(report.usage.requests).toBe(2);
    expect(
      report.probes[0]?.observations.largestAcceptedInputTokens
    ).toBeNull();
  });

  it('user reaches the published context target after confirming an anomalous calibration', async () => {
    // Given a gateway reporting an implausible first token count and consistent counts afterwards.
    relay.mode = 'context-inflated-once';
    relay.contextTokensPerCharacter = 0.65;
    // When the audit checks the published limit using the short calibration sample.
    const report = await runAudit(
      {
        ...input(),
        contextSearch: { initialCharacters: 32768 },
        capabilities: { contextWindowTokens: 100000 },
      },
      options
    );
    // Then a bounded confirmation enables verification using coherent counts and retained recall evidence.
    expect(report.probes[0]?.observations).toMatchObject({
      contextVerification: { verdict: 'pass', reason: 'target_recalled' },
      trials: [
        { phase: 'calibration', reportedInputTokens: 36621 },
        { phase: 'calibration_confirmation', reportedInputTokens: 21300 },
        { phase: 'target_verification', recalled: true },
      ],
    });
    expect(report.usage.requests).toBe(3);
  });
});
