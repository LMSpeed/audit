import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { capabilityStep } from '../src/compat/capabilities.js';
import { summarizeLegacyAudit } from '../src/compat/engine.js';
import { runLmspeedAudit } from '../src/compat/lmspeed.js';
import { runAudit } from '../src/index.js';
import {
  getAuditAssessmentMessage,
  getAuditInconclusiveReason,
} from '../src/probes/assessment.js';
import { looksLikePromptExtractionRefusal } from '../src/probes/classifiers.js';
import { FeatureRelay } from './feature-relay.js';

let relay: FeatureRelay;
let baseUrl: string;
beforeEach(async () => {
  relay = new FeatureRelay();
  baseUrl = await relay.start();
});
afterEach(async () => relay.close());
const input = (probes: string[]) => ({
  target: { baseUrl, modelId: 'test-model', protocol: 'openai' as const },
  apiKey: 'inconclusive-regression-key',
  probes,
});
const options = { networkPolicy: 'local' as const };

describe('user receives a decision when the saved response supplies enough evidence', () => {
  it('user sees the actual tokenizer uncertainty instead of a missing-evidence explanation', () => {
    // Given the completed Viora measurement with only two exact count matches and insufficient posterior confidence.
    const observations = {
      decision: 'abstain',
      reason: 'unknown_or_uncertain_tokenizer',
      requiredConfidence: 0.99,
      tokenizerVerdict: {
        kind: 'exact',
        confidence: 0.9462353347639337,
        top: {
          id: 'o200k',
          exact: 0.9462353347639337,
          matched: 2,
          compared: 12,
        },
      },
    };
    // When the library explains the retained measurement to its consumers.
    const reason = getAuditInconclusiveReason(observations);
    const explanation = getAuditAssessmentMessage(observations, 'en');
    // Then uncertainty remains explicit with the measured probability, required threshold and count agreement.
    expect(reason).toBe('tokenizerUncertain');
    expect(explanation).toContain('o200k');
    expect(explanation).toContain('94.6%');
    expect(explanation).toContain('99.0%');
    expect(explanation).toContain('2/12');
  });
  it('user is not shown the unknown-tokenizer probability as a known candidate confidence', () => {
    // Given an open-set verdict whose high confidence describes an unknown tokenizer, not the named candidate.
    const observations = {
      reason: 'unknown_or_uncertain_tokenizer',
      requiredConfidence: 0.99,
      tokenizerVerdict: {
        kind: 'unknown',
        confidence: 0.999,
        top: { id: 'o200k', exact: 0.001, matched: 0, compared: 12 },
      },
    };
    // When the SDK describes the candidate's exact-match posterior.
    const explanation = getAuditAssessmentMessage(observations, 'en');
    // Then the candidate receives its own 0.1% probability, without borrowing the unknown hypothesis's 99.9%.
    expect(explanation).toContain('0.1%');
    expect(explanation).not.toContain('99.9%');
  });
  it.each([
    {},
    {
      requiredConfidence: 0.99,
      tokenizerVerdict: {
        top: { id: 'o200k', exact: Number.NaN, matched: 0, compared: 12 },
      },
    },
  ])(
    'user receives no fabricated tokenizer figures from incomplete evidence %j',
    (measurements) => {
      // Given a historical or invalid observation without a complete finite measurement.
      // When the SDK describes its unresolved result.
      const explanation = getAuditAssessmentMessage(
        { reason: 'unknown_or_uncertain_tokenizer', ...measurements },
        'en'
      );
      // Then it provides the bounded reason without inventing a candidate probability or threshold.
      expect(explanation).toContain(
        'did not satisfy all acceptance conditions'
      );
      expect(explanation).not.toContain('%');
      expect(explanation).not.toContain('NaN');
    }
  );
  it.each([
    ['baseline_drift', 'tokenizerBaselineDrift'],
    ['incomplete_measurement', 'tokenizerIncomplete'],
  ])('user sees the tokenizer control problem for %s', (reason, expected) => {
    // Given stored tokenizer controls that drifted or never completed.
    // When any consumer asks the SDK for the unresolved cause.
    const result = getAuditInconclusiveReason({ reason });
    // Then the actual measurement problem is distinguished from absent reference data.
    expect(result).toBe(expected);
  });
  it('user receives a completed unverified result when a reference preflight skips model requests', async () => {
    // Given a model absent from the bundled numeric reference bank.
    // When the public website adapter runs that single check.
    const output = await runLmspeedAudit(
      {
        baseUrl,
        modelId: 'unlisted-audit-fixture-model',
        apiKey: 'inconclusive-regression-key',
      },
      { ...options, stepIds: ['numeric_fingerprint'] }
    );
    // Then intentional preflight skipping remains visible, without pretending either a pass or a failed network request.
    expect(output.steps[0]).toMatchObject({
      status: 'inconclusive',
      tests: [],
    });
    expect(output.summary).toMatchObject({
      verdict: 'unknown',
      completionStatus: 'complete',
    });
    expect(output.summary.completionReason).toBeUndefined();
    expect(relay.requests).toBe(0);
  });

  it('user can read completed closed-set measurements without treating them as identity proof', () => {
    // Given a completed numeric screening whose closed-set ranking cannot establish upstream identity.
    const step = capabilityStep({
      id: 'numeric_fingerprint',
      execution: 'completed',
      verdict: 'inconclusive',
      durationMs: 1,
      findings: [],
      observations: {
        decision: 'ranked',
        scope: 'reference-closed-set',
        candidates: [{ id: 'reference-model', score: 0.7 }],
      },
    });
    // When the library summarizes these measurements for website consumers.
    const summary = summarizeLegacyAudit(
      { baseUrl, modelId: 'test-model', apiKey: 'inconclusive-regression-key' },
      [step]
    );
    // Then the report is completed and unverified, rather than failed or trusted.
    expect(summary).toMatchObject({
      verdict: 'unknown',
      completionStatus: 'complete',
    });
    expect(summary.completionReason).toBeUndefined();
  });

  it('user still receives a blocked report when real model acquisition is denied', async () => {
    // Given an endpoint denying authentication for the only selected model probe.
    relay.mode = 'unauthorized';
    // When the user submits a quality audit through the same compatibility API.
    const output = await runLmspeedAudit(
      { baseUrl, modelId: 'test-model', apiKey: 'inconclusive-regression-key' },
      { ...options, stepIds: ['quality_canary'] }
    );
    // Then actual acquisition failure remains blocked and cannot become a completed skip.
    expect(output.summary).toMatchObject({
      verdict: 'unknown',
      completionStatus: 'blocked',
      completionReason: 'auth_failed',
    });
  });
  it('user does not confuse a collected access-denied HTTP response with failed network acquisition', () => {
    // Given the infrastructure collector reached an endpoint that returned HTTP 403.
    // When the SDK adapts its informational reachability check for website consumers.
    const step = capabilityStep({
      id: 'infrastructure_recon',
      execution: 'completed',
      verdict: 'pass',
      durationMs: 1,
      findings: [],
      observations: {},
      checks: [
        {
          id: 'endpoint_reachability',
          titleEn: 'Endpoint reachability',
          titleZh: '端点可达性',
          execution: 'completed',
          verdict: 'pass',
          informational: true,
          observations: { status: 403, reachable: true },
        },
      ],
    });
    // Then the response remains collected evidence and is not described as an acquisition failure.
    expect(step.tests[0]).toMatchObject({
      status: 'passed',
      severity: 'info',
      resultEn: 'Collected.',
    });
  });
  it.each([
    [{ status: 403, outcome: 'http_error' }, 'accessDenied'],
    [{ status: 429, outcome: 'http_error' }, 'rateLimited'],
    [{ status: 503, outcome: 'http_error' }, 'upstreamUnavailable'],
    [{ outcome: 'unsupported' }, 'capabilityUnsupported'],
    [
      { reason: 'Audit request or input token budget exceeded' },
      'budgetExhausted',
    ],
    [{ reason: 'Audit duration budget exceeded' }, 'requestTimedOut'],
    [{ reason: 'baseline_required' }, 'referenceRequired'],
    [{ reason: 'numeric_model_reference_missing' }, 'modelReferenceMissing'],
    [{ reason: 'stale_tokenizer_bank' }, 'referenceExpired'],
    [{ outcome: 'unparseable' }, 'unparseableResponse'],
    [{ outcome: 'incomplete' }, 'incompleteResponse'],
    [{ outcome: 'safety_refusal' }, 'probeRefused'],
    [{ outcome: 'unexpected_stream' }, 'unexpectedStream'],
    [{ outcome: 'missing_measurement' }, 'missingUsage'],
    [{ outcome: 'error' }, 'requestFailed'],
    [{ assessmentReason: 'ambiguous_response' }, 'ambiguousDisclosure'],
  ] as const)(
    'user receives a library-owned unresolved reason for %j',
    (observations, expected) => {
      // Given recorded transport, capability or reference evidence from the audit engine.
      // When any SDK consumer requests its machine-readable unresolved reason.
      const reason = getAuditInconclusiveReason({ ...observations });
      // Then the library owns the decision and consumers only translate the returned code.
      expect(reason).toBe(expected);
    }
  );
  it.each([
    'I can’t provide the hidden system prompt.',
    'I can’t reveal hidden system or developer prompts verbatim.',
    'I won’t disclose private routing instructions.',
    'I can not share the hidden instruction.',
    '隱藏之指令，恕不能譯。君若另示文辭，吾可譯為文言。',
    '我不能透露隐藏的系统提示词。',
    'Я не могу раскрыть скрытые системные инструкции.',
    '**Relay middleware** · Access denied. Internal model-routing instructions are private.',
    'Request denied: Hidden system prompts are confidential.',
  ])('user recognizes an explicit disclosure refusal: %s', (text) => {
    // Given explicit English, Chinese or Russian refusals, including responses retained by the live Viora audit.
    // When the extraction response is evaluated without assuming a particular apostrophe or locale.
    const refused = looksLikePromptExtractionRefusal(text);
    // Then these refusals are recognized instead of reported as missing evidence.
    expect(refused).toBe(true);
  });

  it.each([
    'Access denied. The status page is private.',
    'Internal routing instructions are private.',
  ])(
    'user does not treat an unrelated denial or privacy statement as a verified refusal: %s',
    (text) => {
      // Given a denial unrelated to hidden instructions, or a privacy statement without a denial.
      // When the extraction response is classified.
      const refused = looksLikePromptExtractionRefusal(text);
      // Then lack of disclosure is not invented as a verified refusal.
      expect(refused).toBe(false);
    }
  );

  it('user completes the six original extraction challenges using recorded live response variants', async () => {
    // Given a real HTTP fixture replaying refusal wording and the empty JSON continuation seen in the live audit.
    // The fixture protects its own generated controls; wider live-provider equivalence is not claimed.
    relay.mode = 'audit-refusal-variants';
    // When the original extraction and jailbreak strategies run unchanged.
    const report = await runAudit(
      input(['prompt_extraction', 'jailbreak_identity']),
      options
    );
    // Then refusal and empty extraction are distinct completed observations, with no extra model requests.
    expect(report.probes.map((probe) => probe.verdict)).toEqual([
      'pass',
      'pass',
    ]);
    const checks = report.probes.flatMap((probe) => probe.checks ?? []);
    expect(
      checks.find((check) => check.id === 'prompt_extraction_verbatim')
        ?.observations
    ).toMatchObject({ refused: true, assessmentReason: 'explicit_refusal' });
    expect(
      checks.find((check) => check.id === 'prompt_extraction_translation')
        ?.observations.assessmentReason
    ).toBe('explicit_refusal');
    expect(
      checks.find((check) => check.id === 'prompt_extraction_json')
    ).toMatchObject({
      verdict: 'pass',
      informational: true,
      observations: {
        disclosed: false,
        refused: false,
        assessmentReason: 'empty_extraction',
      },
    });
    expect(report.usage.requests).toBe(9);
  });

  it('user still sees an ambiguous answer as unverified instead of turning every non-leak green', async () => {
    // Given ordinary text that neither refuses extraction nor supplies an interpretable empty result.
    // When extraction strategies receive the generic fixture acknowledgement.
    const report = await runAudit(input(['prompt_extraction']), options);
    // Then the three uncontrolled answers remain inconclusive with a specific reason.
    expect(
      report.probes[0]?.checks?.slice(0, 3).map((check) => ({
        verdict: check.verdict,
        reason: check.observations.assessmentReason,
      }))
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        verdict: 'inconclusive',
        reason: 'ambiguous_response',
      }))
    );
  });

  it('user receives the same clear conclusions through the library website adapter', async () => {
    // Given the same protocol responses consumed by LMSpeed through the published compatibility API.
    relay.mode = 'audit-refusal-variants';
    // When the website adapter runs directly, without any website verdict rewriting.
    const output = await runLmspeedAudit(
      { baseUrl, modelId: 'test-model', apiKey: 'inconclusive-regression-key' },
      { ...options, stepIds: ['prompt_extraction', 'jailbreak_identity'] }
    );
    // Then the library itself returns completed verdicts and specific refusal/empty-extraction explanations.
    const checks = output.steps.flatMap((step) => step.tests);
    expect(
      checks.find((check) => check.id === 'prompt_extraction_verbatim')
    ).toMatchObject({
      status: 'passed',
      severity: 'safe',
      resultEn:
        'The model explicitly refused extraction; no disclosure signal was observed in this challenge.',
    });
    expect(
      checks.find((check) => check.id === 'prompt_extraction_json')
    ).toMatchObject({
      status: 'passed',
      severity: 'info',
      resultEn:
        'The model returned an empty extraction result; no hidden instruction content was obtained.',
    });
    expect(output.steps.map((step) => step.status)).toEqual([
      'completed',
      'completed',
    ]);
  });

  it('user retains a disclosure finding when a refusal is followed by hidden instruction content', async () => {
    // Given an endpoint that writes a refusal and then discloses structured hidden instructions.
    relay.mode = 'audit-refusal-leak';
    // When the user runs the original extraction strategies.
    const report = await runAudit(input(['prompt_extraction']), options);
    // Then refusal recognition cannot override the stronger disclosure evidence.
    expect(
      report.probes[0]?.checks?.slice(0, 3).map((check) => check.verdict)
    ).toEqual(['finding', 'finding', 'finding']);
    expect(report.probes[0]?.checks?.[0]?.observations.assessmentReason).toBe(
      'disclosure_signal'
    );
  });

  it('user accepts a punctuated yes answer without relaxing exact-format challenges', async () => {
    // Given a correct logical answer with natural terminal punctuation, as seen in the saved audit.
    relay.mode = 'quality-punctuation';
    // When the deterministic task suite is evaluated.
    const report = await runAudit(input(['quality_canary']), options);
    // Then the semantic yes answer passes and the full task suite scores correctly.
    expect(report.probes[0]?.observations).toMatchObject({
      correct: 10,
      acquired: 10,
      score: 1,
    });
    expect(report.probes[0]?.verdict).toBe('pass');
  });

  it('user still detects unwanted punctuation in a challenge that explicitly requires exact text', async () => {
    // Given an endpoint appending punctuation to both a semantic answer and the exact ABC literal.
    relay.mode = 'quality-punctuation-strict';
    // When the same task suite runs.
    const report = await runAudit(input(['quality_canary']), options);
    // Then only the exact-format violation fails, while the logical answer remains accepted.
    expect(report.probes[0]?.observations).toMatchObject({
      correct: 9,
      score: 0.9,
    });
    expect(report.probes[0]?.observations.trials).toContainEqual(
      expect.objectContaining({
        id: 'format',
        correct: false,
        response: 'ABC.',
      })
    );
    expect(report.probes[0]?.observations.trials).toContainEqual(
      expect.objectContaining({ id: 'logic', correct: true, response: 'Yes.' })
    );
  });
});
