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
  it('user gets an automatic search even after providing a declared token window', async () => {
    // Given a declared token window and an endpoint whose real admission boundary is above 16384 characters.
    relay.contextLimit = 100000;
    const target = input();
    target.capabilities = { contextWindowTokens: 1000000 };
    // When context-window detection runs with that hint.
    const report = await runAudit(target, options);
    const observed = report.probes[0]!.observations;
    // Then the hint does not downgrade measurement to a tiny fixed recall sample.
    expect(Number(observed.largestAcceptedCharacters)).toBeGreaterThan(16384);
    expect(observed.smallestRejectedCharacters).toBeGreaterThan(100000);
    expect(observed.upperBoundObserved).toBe(true);
  });
});
