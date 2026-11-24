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
import { probeConditionalInjection } from './probes/conditional.js';
import { probeInfrastructure } from './probes/infrastructure.js';
import { probeQuality, probeQualityComparison } from './probes/quality.js';
import { reviewAuditResult } from './probes/result-review.js';
import { result as makeResult } from './probes/results.js';
import type { FetchCompletion } from './protocols/completion.js';
import { createProbeEvidence } from './protocols/evidence.js';
import { createAuditTransport, validateTarget } from './protocols/transport.js';
import { redactRelayAuditText } from './redaction.js';
import type {
  AuditInput,
  AuditOptions,
  AuditReport,
  ProbeResult,
} from './schema/index.js';
import { validateDetectorConfiguration } from './schema/validate.js';
import { ENGINE_VERSION, RULESET_VERSION } from './version.js';

export { ENGINE_VERSION, RULESET_VERSION } from './version.js';
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
            (id !== 'numeric_fingerprint' ||
              input.numericFingerprint ||
              input.referenceData !== 'disabled') &&
            (id !== 'tokenizer_fingerprint' ||
              input.tokenizer ||
              input.referenceData !== 'disabled')
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
async function executeProbe(
  id: string,
  input: AuditInput,
  fetch: FetchCompletion,
  options: AuditOptions,
  reserveRequest: () => void
): Promise<ProbeResult> {
  switch (id) {
    case 'token_injection':
      return input.capabilities?.tokenBaselines
        ? probeBoundary(id, input, fetch, options)
        : makeResult(
            id,
            performance.now(),
            {
              reason: 'A calibrated model-specific token baseline is required',
            },
            [],
            'unsupported'
          );
    case 'infrastructure_recon':
      return probeInfrastructure(input, fetch, options, reserveRequest);
    case 'tool_calling':
      return probeTools(input, fetch);
    case 'structured_output':
      return probeStructuredOutput(input, fetch);
    case 'image_understanding':
      return probeMedia(input, fetch, 'image');
    case 'pdf_understanding':
      return probeMedia(input, fetch, 'pdf');
    case 'context_recall':
      return probeContextRecall(input, fetch);
    case 'stream_consistency':
      return probeStreamConsistency(input, fetch);
    case 'quality_canary':
      return probeQuality(input, fetch);
    case 'quality_comparison':
      return probeQualityComparison(input, fetch);
    case 'conditional_injection':
      return probeConditionalInjection(input, fetch);
    case 'model_fingerprint':
      return probeModelFingerprint(input, fetch);
    case 'tokenizer_fingerprint':
      return probeTokenizer(input, fetch);
    case 'numeric_fingerprint':
      return probeNumericFingerprint(input, fetch);
    default:
      return probeBoundary(id, input, fetch, options);
  }
}

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export async function executeAudit(
  input: AuditInput,
  options: AuditOptions = {},
  legacyOptions: RelayAuditEngineOptions = {}
) {
  if (!input.apiKey?.trim() || !input.target.modelId?.trim())
    throw new Error('API key and model ID are required');
  const requested = createAuditPlan(input);
  const concurrency = options.probeConcurrency ?? 1;
  const probeDuration = options.limits?.maxProbeDurationMs;
  let retriesRemaining = options.limits?.maxTransientRetries ?? 0;
  if (!Number.isSafeInteger(retriesRemaining) || retriesRemaining < 0)
    throw new Error('Transient retry limit must be a nonnegative safe integer');
  const reserveRetry = () => {
    if (retriesRemaining === 0) return false;
    retriesRemaining--;
    return true;
  };
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    throw new Error('Probe concurrency must be a positive safe integer');
  if (
    probeDuration !== undefined &&
    (!Number.isSafeInteger(probeDuration) ||
      probeDuration < 1 ||
      probeDuration > 2_147_483_647)
  )
    throw new Error(
      'Probe duration limit must be between 1 and 2147483647 milliseconds'
    );

  const startedAt = new Date().toISOString();
  const controller = new AbortController();
  const workSignal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const transport = createAuditTransport({ ...options, signal: workSignal });
  const resultsById = new Map<string, ProbeResult>();
  const stepsById = new Map<string, RelayAuditEngineStep>();
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

  // Keep awaited progress and persistence callbacks ordered while requests overlap.
  let updates = Promise.resolve();
  const publish = (update: () => Promise<void>) => {
    updates = updates.then(() => {
      workSignal.throwIfAborted();
      return update();
    });
    return updates;
  };
  const complete = (probe: ProbeResult, missedDeadline = false) =>
    publish(async () => {
      resultsById.set(probe.id, probe);
      if (probe.id !== 'channel_classifier') {
        const step = capabilityStep(
          missedDeadline ? { ...probe, execution: 'error' } : probe
        );
        stepsById.set(probe.id, step);
        const steps = requested.flatMap((id) => {
          const finished = stepsById.get(id);
          return finished ? [finished] : [];
        });
        legacy = {
          version: 'lmspeed-relay-audit-node-v1',
          targetUrl: input.target.baseUrl,
          modelId: input.target.modelId,
          startedAt,
          finishedAt: new Date().toISOString(),
          summary: summarizeLegacyAudit(
            { ...input.target, apiKey: input.apiKey },
            steps
          ),
          signals: {},
          requestedStepIds: steps.map(({ id }) => id),
          steps,
          tokenUsage: transport.tokenUsage(),
          provenance: {
            engineVersion: ENGINE_VERSION,
            rulesetVersion: RULESET_VERSION,
            assessmentPolicy: 'lmspeed-independent-evidence-v3',
            coverage: {
              requested: [...requested],
              inconclusive: requested.filter(
                (id) => resultsById.get(id)?.verdict === 'inconclusive'
              ),
            },
          },
        };
        await legacyOptions.onProgress?.({
          event: 'progress',
          stage: step.id,
          status: step.status === 'failed' ? 'failed' : 'completed',
          severity: step.severity,
          messageEn: step.summaryEn,
          messageZh: step.summaryZh,
        });
        await legacyOptions.onStepComplete?.(legacy);
      }
      await options.onEvent?.({
        type: 'probe_completed',
        probeId: probe.id,
        result: probe,
      });
    });
  const run = async (id: string) => {
    workSignal.throwIfAborted();
    if (transport.signal.aborted) {
      await complete(
        {
          id,
          execution: 'skipped',
          verdict: 'inconclusive',
          durationMs: 0,
          observations: { reason: errorMessage(transport.signal.reason) },
          findings: [],
        },
        true
      );
      return;
    }
    await publish(async () => {
      await options.onEvent?.({ type: 'probe_started', probeId: id });
      if (id !== 'channel_classifier')
        await legacyOptions.onProgress?.({
          event: 'progress',
          stage: id as RelayAuditEngineStep['id'],
          status: 'running',
        });
    });
    const started = performance.now();
    const probeController = new AbortController();
    const signal = AbortSignal.any([transport.signal, probeController.signal]);
    const deadline =
      probeDuration === undefined
        ? undefined
        : setTimeout(() => {
            probeController.abort(new Error('Audit probe timed out'));
          }, probeDuration).unref();
    const evidence = createProbeEvidence(
      (url, init) =>
        transport.fetch(url, {
          ...init,
          signal: init?.signal
            ? AbortSignal.any([signal, init.signal])
            : signal,
        }),
      scrub,
      signal,
      id === 'context_window' ||
        id === 'context_recall' ||
        id === 'latency_variance'
        ? undefined
        : reserveRetry
    );
    let probe: ProbeResult;
    try {
      signal.throwIfAborted();
      probe = await executeProbe(
        id,
        input,
        evidence.fetch,
        { ...options, signal },
        () => {
          signal.throwIfAborted();
          transport.reserveRequest();
        }
      );
    } catch (error) {
      probe = makeResult(
        id,
        started,
        { reason: errorMessage(error) },
        [],
        'error'
      );
    } finally {
      if (deadline) clearTimeout(deadline);
    }
    workSignal.throwIfAborted();
    if (signal.aborted)
      probe = {
        ...probe,
        execution: 'error',
        verdict: probe.findings.length ? 'finding' : 'inconclusive',
        observations: {
          ...probe.observations,
          reason: errorMessage(signal.reason),
        },
      };
    if (options.reviewAmbiguousResults && !signal.aborted) {
      await reviewAuditResult(input, transport.fetch, probe, scrub);
    }
    workSignal.throwIfAborted();
    await complete(
      JSON.parse(scrub(JSON.stringify(evidence.attach(probe)))) as ProbeResult
    );
  };

  try {
    await validateTarget(
      input.target.baseUrl,
      options.networkPolicy,
      transport.signal
    );
    // Measure latency without other traffic from the same audit.
    const isolateLatency =
      concurrency > 1 && requested.includes('latency_variance');
    const queue = (
      isolateLatency
        ? requested.filter((id) => id !== 'latency_variance')
        : requested
    ).values();
    const runWorker = async () => {
      try {
        for (const id of queue) await run(id);
      } catch (error) {
        controller.abort(error);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, requested.length) }, runWorker)
    );
    workSignal.throwIfAborted();
    if (isolateLatency) await run('latency_variance');

    const results = requested.map((id) => resultsById.get(id)!);
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
      usage: { ...transport.usage, tokens: transport.tokenUsage() },
    };
    return { report, legacy };
  } finally {
    transport.close();
  }
}
