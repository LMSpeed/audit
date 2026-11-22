import { RELAY_AUDIT_STEP_IDS } from './catalog.js';
import { capabilityStep } from './compat/capabilities.js';
import {
  type RelayAuditEngineOptions,
  summarizeLegacyAudit,
} from './compat/engine.js';
import type {
  RelayAuditEngineOutput,
  RelayAuditEngineStep,
} from './compat/types.js';
import { probeModelFingerprint } from './identity/distribution.js';
import { probeNumericFingerprint } from './identity/numeric.js';
import { probeTokenizer } from './identity/tokenizer.js';
import { probeBoundary } from './probes/boundaries.js';
import {
  probeContextRecall,
  probeMedia,
  probeStreamConsistency,
  probeStructuredOutput,
  probeTools,
} from './probes/capabilities.js';
import { CAPABILITY_IDS } from './probes/catalog.js';
import { probeConditionalInjection } from './probes/conditional.js';
import { probeQuality, probeQualityComparison } from './probes/quality.js';
import { result as makeResult } from './probes/results.js';
import { createAuditTransport, validateTarget } from './protocols/transport.js';
import { redactRelayAuditText } from './redaction.js';
import type {
  AuditInput,
  AuditOptions,
  AuditReport,
  ProbeResult,
} from './schema/index.js';
import { validateDetectorConfiguration } from './schema/validate.js';
export const ENGINE_VERSION = '0.3.0';
export const RULESET_VERSION = 'independent-2026-11-22.1';
export const AUDIT_PROBE_IDS = [
  ...RELAY_AUDIT_STEP_IDS,
  'channel_classifier',
] as const;

export function createAuditPlan(input: AuditInput) {
  validateDetectorConfiguration(input);
  const profile = input.profile ?? 'general';
  const calibrated = input.capabilities?.tokenBaselines;
  if (
    calibrated &&
    !['plain', 'system', 'question'].every(
      (id) => Number.isSafeInteger(calibrated[id]) && calibrated[id]! >= 0
    )
  )
    throw new Error(
      'All three model token probes require calibrated baselines'
    );
  const context = input.capabilities?.contextWindowTokens;
  if (context !== undefined && (!Number.isSafeInteger(context) || context <= 0))
    throw new Error('Expected context window must be a positive token count');
  if (!['general', 'connectivity', 'web3', 'full'].includes(profile))
    throw new Error('Unknown audit profile');
  if (
    input.target.protocol &&
    !['auto', 'openai', 'anthropic', 'responses'].includes(
      input.target.protocol
    )
  )
    throw new Error('Unknown audit protocol');
  const defaults =
    profile === 'connectivity'
      ? ['model_list', 'stream_integrity']
      : AUDIT_PROBE_IDS.filter(
          (id) =>
            (id !== 'web3_prompt_injection' ||
              ['web3', 'full'].includes(profile)) &&
            (id !== 'token_injection' || input.capabilities?.tokenBaselines) &&
            (id !== 'image_understanding' || input.capabilities?.vision) &&
            (id !== 'pdf_understanding' || input.capabilities?.pdf) &&
            (id !== 'context_recall' || input.context) &&
            (id !== 'quality_comparison' || input.reference) &&
            (id !== 'model_fingerprint' || input.identity) &&
            (id !== 'numeric_fingerprint' || input.numericFingerprint) &&
            (id !== 'tokenizer_fingerprint' || input.tokenizer)
        );
  const requested = input.probes ? [...new Set(input.probes)] : defaults;
  if (
    !requested.length ||
    requested.some(
      (id) => !AUDIT_PROBE_IDS.includes(id as (typeof AUDIT_PROBE_IDS)[number])
    )
  )
    throw new Error('Unknown or empty audit probe selection');
  return requested;
}
export async function executeAudit(
  input: AuditInput,
  options: AuditOptions = {},
  legacyOptions: RelayAuditEngineOptions = {}
) {
  if (!input.apiKey?.trim() || !input.target.modelId?.trim())
    throw new Error('API key and model ID are required');
  const requested = createAuditPlan(input);
  await validateTarget(input.target.baseUrl, options.networkPolicy);
  const startedAt = new Date().toISOString();
  const transport = createAuditTransport(options);
  const results: ProbeResult[] = [];
  let legacy: RelayAuditEngineOutput | undefined;
  const secrets = [
    input.apiKey,
    input.reference?.apiKey,
    input.judge?.apiKey,
  ].filter((key): key is string => Boolean(key));
  const scrub = (text: string) =>
    redactRelayAuditText(
      secrets.reduce(
        (text, key) => text.split(key).join('[redacted-key]'),
        text
      )
    );
  try {
    for (const id of requested) {
      transport.signal.throwIfAborted();
      await options.onEvent?.({ type: 'probe_started', probeId: id });
      if (id !== 'channel_classifier')
        await legacyOptions.onProgress?.({
          event: 'progress',
          stage: id as RelayAuditEngineStep['id'],
          status: 'running',
        });
      let result: ProbeResult;
      if (id === 'token_injection' && !input.capabilities?.tokenBaselines) {
        result = {
          id,
          execution: 'unsupported',
          verdict: 'inconclusive',
          durationMs: 0,
          findings: [],
          observations: {
            reason: 'A calibrated model-specific token baseline is required',
          },
        };
      } else if (
        CAPABILITY_IDS.includes(id as (typeof CAPABILITY_IDS)[number])
      ) {
        result =
          id === 'tool_calling'
            ? await probeTools(input, transport.fetch)
            : id === 'structured_output'
              ? await probeStructuredOutput(input, transport.fetch)
              : id === 'image_understanding'
                ? await probeMedia(input, transport.fetch, 'image')
                : id === 'pdf_understanding'
                  ? await probeMedia(input, transport.fetch, 'pdf')
                  : id === 'context_recall'
                    ? await probeContextRecall(input, transport.fetch)
                    : id === 'stream_consistency'
                      ? await probeStreamConsistency(input, transport.fetch)
                      : id === 'quality_canary'
                        ? await probeQuality(input, transport.fetch)
                        : id === 'quality_comparison'
                          ? await probeQualityComparison(input, transport.fetch)
                          : id === 'conditional_injection'
                            ? await probeConditionalInjection(
                                input,
                                transport.fetch
                              )
                            : id === 'model_fingerprint'
                              ? await probeModelFingerprint(
                                  input,
                                  transport.fetch
                                )
                              : id === 'tokenizer_fingerprint'
                                ? await probeTokenizer(input, transport.fetch)
                                : id === 'numeric_fingerprint'
                                  ? await probeNumericFingerprint(
                                      input,
                                      transport.fetch
                                    )
                                  : makeResult(
                                      id,
                                      performance.now(),
                                      {
                                        reason:
                                          'Reference configuration required',
                                      },
                                      [],
                                      'unsupported'
                                    );
      } else {
        result = await probeBoundary(id, input, transport.fetch, options);
      }
      transport.signal.throwIfAborted();
      result = JSON.parse(scrub(JSON.stringify(result))) as ProbeResult;
      results.push(result);
      if (id !== 'channel_classifier') {
        const step = capabilityStep(result);
        legacy ??= {
          version: 'lmspeed-relay-audit-node-v1',
          targetUrl: input.target.baseUrl,
          modelId: input.target.modelId,
          startedAt,
          finishedAt: startedAt,
          summary: {
            verdict: 'unknown',
            headlineZh: '检测中',
            headlineEn: 'Audit in progress',
          },
          signals: {},
          requestedStepIds: [],
          steps: [],
        };
        legacy.steps.push(step);
        legacy.requestedStepIds!.push(step.id);
        legacy.finishedAt = new Date().toISOString();
        legacy.provenance = {
          engineVersion: ENGINE_VERSION,
          rulesetVersion: RULESET_VERSION,
          assessmentPolicy: 'lmspeed-independent-evidence-v3',
          coverage: {
            requested: [...requested],
            inconclusive: results
              .filter((probe) => probe.verdict === 'inconclusive')
              .map((probe) => probe.id),
          },
        };
        legacy.summary = summarizeLegacyAudit(
          { ...input.target, apiKey: input.apiKey },
          legacy.steps
        );

        await legacyOptions.onProgress?.({
          event: 'progress',
          stage: step.id,
          status: result.execution === 'error' ? 'failed' : 'completed',
          severity: step.severity,
          messageEn: step.summaryEn,
          messageZh: step.summaryZh,
        });
        await legacyOptions.onStepComplete?.(legacy);
      }
      await options.onEvent?.({ type: 'probe_completed', probeId: id, result });
    }
    const findings = results.flatMap((result) => result.findings);
    const report: AuditReport = {
      schemaVersion: '1',
      engineVersion: ENGINE_VERSION,
      rulesetVersion: RULESET_VERSION,
      target: input.target,
      startedAt,
      finishedAt: new Date().toISOString(),
      probes: results,
      findings,
      coverage: {
        requested,
        completed: results
          .filter((r) => r.execution === 'completed')
          .map((r) => r.id),
        inconclusive: results
          .filter((r) => r.verdict === 'inconclusive')
          .map((r) => r.id),
        blocked: results
          .filter((r) => r.execution === 'blocked')
          .map((r) => r.id),
        unsupported: results
          .filter((r) => r.execution === 'unsupported')
          .map((r) => r.id),
        skipped: results
          .filter((r) => r.execution === 'skipped')
          .map((r) => r.id),
      },
      assessment: {
        policyId: 'lmspeed-independent-evidence-v3',
        verdict: findings.length
          ? 'findings'
          : results.some((r) => r.verdict === 'inconclusive')
            ? 'inconclusive'
            : 'no_findings',
      },
      usage: { ...transport.usage },
    };
    return { report, legacy };
  } finally {
    transport.close();
  }
}
