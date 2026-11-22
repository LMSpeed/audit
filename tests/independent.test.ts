import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAudit } from '../src/index.js';
import { IndependentRelay } from './independent-relay.js';

// Surface: SDK through real HTTP. Live-provider equivalence is unverified.
let relay: IndependentRelay;
let baseUrl: string;
beforeEach(async () => {
  relay = new IndependentRelay();
  baseUrl = await relay.start();
});
afterEach(async () => {
  await relay.close();
});
const options = { networkPolicy: 'local' as const, pacingMs: 0 };
const run = (
  probes: string[],
  protocol: 'openai' | 'anthropic' | 'responses' = 'openai'
) =>
  runAudit(
    {
      target: { baseUrl, modelId: relay.model, protocol },
      apiKey: 'private-test-credential',
      probes,
    },
    options
  );

describe('user receives independently specified audit evidence', () => {
  it.each(['openai', 'anthropic', 'responses'] as const)(
    'user receives an unambiguous expected literal in the %s priority challenge',
    async (protocol) => {
      // Given a protocol fixture treating punctuation attached to an unquoted literal as part of that literal.
      relay.mode = 'literal-boundary';
      // When the user runs the system-priority challenge.
      const report = await run(['instruction_conflict'], protocol);
      // Then the requested output boundary is unambiguous and the honoring endpoint passes.
      expect(report.probes[0]?.verdict).toBe('pass');
      expect(report.probes[0]?.observations).toMatchObject({ matched: true });
      expect(report.findings).toEqual([]);
    }
  );
  it('user still detects extra punctuation after an unambiguous expected literal', async () => {
    // Given an endpoint appending a period to the explicitly requested literal.
    relay.mode = 'append-punctuation';
    // When the system-priority challenge is evaluated.
    const report = await run(['instruction_conflict']);
    // Then the output contract remains strict rather than stripping punctuation to manufacture a pass.
    expect(report.probes[0]?.verdict).toBe('finding');
    expect(report.probes[0]?.observations.received).toBe(
      `${report.probes[0]?.observations.expected}.`
    );
    expect(report.findings.map((finding) => finding.code)).toEqual([
      'system_priority_mismatch',
    ]);
  });
  it.each(['openai', 'anthropic', 'responses'] as const)(
    'user can check system priority and literal integrity over %s',
    async (protocol) => {
      // Given a protocol endpoint honoring system priority and literal output.
      const probes = ['instruction_conflict', 'tool_substitution'];
      // When the user submits randomized contract challenges.
      const report = await run(probes, protocol);
      // Then both contracts pass without model-specific prompt assumptions.
      expect(report.probes.map((p) => p.verdict)).toEqual(['pass', 'pass']);
      expect(report.findings).toEqual([]);
    }
  );
  it('user sees a priority violation when the randomized system instruction is ignored', async () => {
    // Given a relay ignoring system instructions.
    relay.mode = 'ignore-system';
    // When the user checks priority handling.
    const report = await run(['instruction_conflict']);
    // Then the failed challenge is visible without claiming model substitution.
    expect(report.findings.map((f) => f.code)).toEqual([
      'system_priority_mismatch',
    ]);
    expect(report.findings[0]?.confidence).toBe('weak');
  });
  it('user sees exact secret disclosure even alongside a refusal', async () => {
    // Given a response that discloses the generated protected value.
    relay.mode = 'leak';
    // When direct and transformed disclosure attempts are tested.
    const report = await run(['prompt_extraction', 'jailbreak_identity']);
    // Then both probes report the observable disclosure.
    expect(report.probes.map((p) => p.verdict)).toEqual(['finding', 'finding']);
    expect(report.findings.every((f) => f.confidence === 'strong')).toBe(true);
  });
  it('user can inspect a sanitized malformed-input rejection', async () => {
    // Given an endpoint that produces a normal response even to an invalid model request.
    // When its malformed JSON rejection contains no secret.
    const report = await run(['error_leakage']);
    // Then an observed, sanitized rejection passes the disclosure check.
    expect(report.probes[0]?.verdict).toBe('pass');
    expect(report.probes[0]?.observations.errorResponses).toBe(1);
  });
  it('user receives redacted evidence when an error exposes connection credentials', async () => {
    // Given a malformed-input error containing a database credential.
    relay.mode = 'leaky-error';
    // When the error boundary is audited.
    const report = await run(['error_leakage']);
    // Then the leak is reported without reproducing its password.
    expect(report.findings.map((f) => f.code)).toEqual([
      'error_sensitive_assignment',
    ]);
    expect(JSON.stringify(report)).not.toContain('admin:password');
  });
  it.each(['openai', 'anthropic', 'responses'] as const)(
    'user receives a stream contract result for %s',
    async (protocol) => {
      // Given a complete protocol stream.
      // When the selected stream contract is checked.
      const report = await run(['stream_integrity'], protocol);
      // Then termination and model consistency pass for that format.
      expect(report.probes[0]?.verdict).toBe('pass');
    }
  );
  it.each(['openai', 'anthropic', 'responses'] as const)(
    'user receives a truncation finding for %s',
    async (protocol) => {
      // Given a stream with no required terminal marker.
      relay.mode = 'truncated';
      // When the user audits it.
      const report = await run(['stream_integrity'], protocol);
      // Then the missing terminal cannot be a pass.
      expect(report.probes[0]?.verdict).toBe('finding');
    }
  );
  it('user does not receive a model authenticity claim from wallet policy checks', async () => {
    // Given a response approving disclosure of wallet secrets.
    relay.mode = 'unsafe-wallet';
    // When wallet recovery policy is checked.
    const report = await run(['web3_prompt_injection']);
    // Then a policy violation is identified as weak evidence only.
    expect(report.findings.map((f) => f.code)).toEqual([
      'wallet_policy_mismatch',
    ]);
    expect(report.findings[0]?.confidence).toBe('weak');
  });
  it('user cannot send private credentials under the public network policy', async () => {
    // Given a loopback target with the public policy.
    // When the user attempts to audit it.
    const operation = runAudit({
      target: { baseUrl, modelId: relay.model },
      apiKey: 'private-test-credential',
      probes: ['model_list'],
    });
    // Then it is rejected before the first request.
    await expect(operation).rejects.toThrow(/HTTPS|private/);
    expect(relay.requests).toBe(0);
  });
  it('user cannot spend more than the shared request budget', async () => {
    // Given multiple probes sharing a one-request budget.
    // When the SDK executes them.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: relay.model },
        apiKey: 'private-test-credential',
        probes: ['model_list', 'instruction_conflict'],
      },
      { ...options, limits: { maxRequests: 1 } }
    );
    // Then the later probe remains inconclusive and the budget is respected.
    expect(report.usage.requests).toBe(1);
    expect(relay.requests).toBe(1);
    expect(report.coverage.inconclusive).toContain('instruction_conflict');
  });
});
