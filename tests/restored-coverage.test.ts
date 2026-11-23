import { readFileSync } from 'node:fs';
import { createServer as createTlsServer } from 'node:https';
import { type AddressInfo, createServer as createWhoisServer } from 'node:net';
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
const options = { networkPolicy: 'local' as const };
const input = (probes: string[]) => ({
  target: { baseUrl, modelId: 'test-model', protocol: 'openai' as const },
  apiKey: 'coverage-private-key',
  probes,
});

describe('user retains the original audit capabilities', () => {
  it('user automatically finds a bounded usable context interval without configuration', async () => {
    // Given an endpoint that accepts small contexts and rejects larger inputs.
    relay.contextLimit = 12000;
    // When the user requests a context-window audit without size configuration.
    const report = await runAudit(input(['context_window']), options);
    // Then exponential exploration and refinement report both sides of the boundary.
    expect(report.probes[0]?.observations).toMatchObject({
      searchComplete: true,
      upperBoundObserved: true,
    });
    const observations = report.probes[0]!.observations;
    expect(Number(observations.largestPassedCharacters)).toBeLessThanOrEqual(
      12000
    );
    expect(Number(observations.smallestFailedCharacters)).toBeGreaterThan(
      12000
    );
    expect(
      Number(observations.smallestFailedCharacters) -
        Number(observations.largestPassedCharacters)
    ).toBeLessThanOrEqual(4096);
    expect(report.usage.requests).toBeLessThanOrEqual(12);
  });

  it('user does not mistake authentication failures for a context boundary', async () => {
    // Given an endpoint that denies access at every input length.
    relay.mode = 'unauthorized';
    // When automatic context search starts.
    const report = await runAudit(input(['context_window']), options);
    // Then missing access leaves capacity unknown rather than reporting a tiny window.
    expect(report.probes[0]?.verdict).toBe('inconclusive');
    expect(
      report.probes[0]?.observations.smallestFailedCharacters ?? null
    ).toBeNull();
    expect(report.usage.requests).toBe(1);
  });

  it('user sees a lower bound when the endpoint recalls the entire bounded search', async () => {
    // Given an endpoint retaining every marker up to the resource cap.
    // When the automatic search reaches its maximum test length.
    const report = await runAudit(
      {
        ...input(['context_window']),
        contextSearch: { maximumCharacters: 524288 },
      },
      options
    );
    // Then the report distinguishes a lower bound from a measured ceiling.
    expect(report.probes[0]?.observations).toMatchObject({
      searchComplete: false,
      capacityStatus: 'lower_bound',
      stopReason: 'character_limit',
      upperBoundObserved: false,
      largestPassedCharacters: 524288,
      smallestFailedCharacters: null,
    });
    expect(report.usage.requests).toBeLessThanOrEqual(12);
  });

  it('user receives incomplete context evidence when the request budget runs out', async () => {
    // Given a search limited to one real model request.
    // When additional lengths would exceed that shared budget.
    const report = await runAudit(input(['context_window']), {
      ...options,
      limits: { maxRequests: 1 },
    });
    // Then the known lower bound survives without inventing an upper limit.
    expect(report.usage.requests).toBe(1);
    expect(relay.requests).toBe(1);
    expect(report.probes[0]?.verdict).toBe('inconclusive');
    expect(report.probes[0]?.observations).toMatchObject({
      searchComplete: false,
      upperBoundObserved: false,
      largestAcceptedCharacters: 32768,
      largestPassedCharacters: 32768,
      stopReason: 'budget_exhausted',
    });
  });

  it('user does not interpret a transient recall miss as a context capacity limit', async () => {
    // Given an endpoint missing a marker once but recalling it on confirmation.
    relay.lostNeedleOnce = true;
    // When the automatic search verifies the apparent boundary.
    const report = await runAudit(input(['context_window']), options);
    // Then instability remains inconclusive rather than a confirmed ceiling.
    expect(report.probes[0]?.verdict).toBe('inconclusive');
    expect(report.probes[0]?.observations).toMatchObject({
      searchComplete: false,
      smallestFailedCharacters: null,
    });
  });

  it('user sees repeated marker loss as a recall warning rather than a successful capacity scan', async () => {
    // Given an endpoint silently losing early markers only for longer prompts.
    relay.recallLimit = 12000;
    // When automatic context search repeats the failing challenge.
    const report = await runAudit(input(['context_window']), options);
    // Then the measured interval retains a warning without asserting its cause.
    expect(report.probes[0]?.verdict).toBe('finding');
    expect(report.findings.map((finding) => finding.code)).toContain(
      'context_recall_missing'
    );
    expect(report.probes[0]?.observations).toMatchObject({
      upperBoundObserved: false,
      smallestRejectedCharacters: null,
      recallStatus: 'loss_observed',
    });
  });

  it.each([
    'one-api',
    'litellm',
    'mixed-gateway',
    'healthy',
    'lobechat-relay',
    'fastgpt',
    'cloudflare',
    'nginx-raw',
    'caddy-raw',
    'new-api-behind-cloudflare',
  ])('user retains conservative framework attribution for %s', async (mode) => {
    // Given branded, conflicting or unbranded entry points.
    relay.mode = mode;
    // When the user inspects all gateway routes.
    const report = await runAudit(
      input(['infrastructure_fingerprint']),
      options
    );
    // Then conflicting and absent evidence stay distinct from a unique match.
    expect(report.probes[0]?.observations.framework).toBe(
      mode === 'mixed-gateway'
        ? 'ambiguous'
        : mode === 'healthy'
          ? 'unknown'
          : mode === 'new-api-behind-cloudflare'
            ? 'new-api'
            : mode
    );
    expect(report.probes[0]?.verdict).toBe(
      ['mixed-gateway', 'healthy'].includes(mode) ? 'inconclusive' : 'pass'
    );
  });

  it('user cannot exceed the shared budget through framework routes', async () => {
    // Given a framework scan with one permitted request.
    // When subsequent routes cannot be acquired.
    const report = await runAudit(input(['infrastructure_fingerprint']), {
      ...options,
      limits: { maxRequests: 1 },
    });
    // Then no additional traffic escapes the shared limit.
    expect(report.usage.requests).toBe(1);
    expect(relay.requests).toBe(1);
    expect(report.probes[0]?.verdict).toBe('inconclusive');
  });

  it('user retains each original prompt extraction and jailbreak result in the website report', async () => {
    // Given an endpoint with a concealed gateway instruction and a disclosure flaw.
    relay.mode = 'hidden-prompt-leak';
    // When all original extraction strategies run through the website adapter.
    const report = await runLmspeedAudit(
      { baseUrl, modelId: 'test-model', apiKey: 'coverage-private-key' },
      { ...options, stepIds: ['prompt_extraction', 'jailbreak_identity'] }
    );
    // Then the six original strategies remain individual evidence-bearing results.
    const tests = report.steps.flatMap((step) => step.tests);
    for (const id of [
      'prompt_extraction_verbatim',
      'prompt_extraction_translation',
      'prompt_extraction_json',
      'jailbreak_system_diagnostic',
      'jailbreak_base64',
      'jailbreak_role_play',
    ]) {
      expect(tests.find((test) => test.id === id)).toMatchObject({
        status: 'failed',
      });
    }
    expect(
      report.steps.every((step) =>
        step.tables.some((table) =>
          table.rows.some(
            (row) =>
              typeof row.userPrompt === 'string' &&
              typeof row.response === 'string'
          )
        )
      )
    ).toBe(true);
    expect(JSON.stringify(report)).not.toContain('coverage-private-key');
  });

  it('user identifies a gateway framework from landing-page evidence', async () => {
    // Given a New API gateway exposing its frontend identity.
    relay.mode = 'new-api';
    // When the user audits the gateway independently of model identity.
    const report = await runAudit(
      input(['infrastructure_fingerprint']),
      options
    );
    // Then the framework and its supporting route evidence are retained.
    expect(report.probes[0]?.observations).toMatchObject({
      framework: 'new-api',
    });
    expect(JSON.stringify(report.probes[0]?.observations)).toContain('New API');
  });

  it('user retains DNS TLS and WHOIS evidence even when the HTTP entry rejects a certificate', async () => {
    // Given a real local TLS endpoint and a bounded WHOIS protocol server.
    const tls = createTlsServer(
      {
        key: readFileSync(
          new URL('./fixtures/localhost-key.pem', import.meta.url)
        ),
        cert: readFileSync(
          new URL('./fixtures/localhost-cert.pem', import.meta.url)
        ),
      },
      (_req, res) => {
        res.end('ready');
      }
    );
    const whois = createWhoisServer((socket) => {
      socket.once('data', () =>
        socket.end('Domain Name: LOCALHOST\r\nRegistrar: Local fixture\r\n')
      );
    });
    await Promise.all([
      new Promise<void>((resolve) => tls.listen(0, resolve)),
      new Promise<void>((resolve) => whois.listen(0, '127.0.0.1', resolve)),
    ]);
    try {
      // When the user collects infrastructure information through the SDK entry point.
      const report = await runLmspeedAudit(
        {
          baseUrl: `https://localhost:${(tls.address() as AddressInfo).port}/v1`,
          modelId: 'test-model',
          apiKey: 'coverage-private-key',
        },
        {
          ...options,
          stepIds: ['infrastructure_recon'],
          infrastructure: {
            whoisServer: {
              host: '127.0.0.1',
              port: (whois.address() as AddressInfo).port,
            },
          },
        }
      );
      // Then unreachable HTTP cannot erase independently collected network evidence.
      const tests = report.steps[0]!.tests;
      expect(
        tests.find((test) => test.id === 'dns_records')?.evidenceEn
      ).toContain('127.0.0.1');
      expect(
        tests.find((test) => test.id === 'tls_certificate')?.evidenceEn
      ).toContain('localhost');
      expect(
        tests.find((test) => test.id === 'whois_lookup')?.evidenceEn
      ).toContain('Local fixture');
    } finally {
      tls.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => tls.close(() => resolve())),
        new Promise<void>((resolve) => whois.close(() => resolve())),
      ]);
    }
  });
});
