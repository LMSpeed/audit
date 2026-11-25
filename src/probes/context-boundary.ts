import { randomBytes } from 'node:crypto';
import {
  type Completion,
  type FetchCompletion,
  requestCompletion,
} from '../protocols/completion.js';
import { isTransientConnectionError } from '../protocols/evidence.js';
import type { AuditInput } from '../schema/index.js';
import { finding, result } from './results.js';

function contextRejected(response: Completion) {
  return (
    response.outcome === 'http_error' &&
    [400, 413, 422].includes(response.status) &&
    /context[_ -]?(?:length|window).*(?:exceed|limit|maximum)|maximum context|\b(?:prompt|input)(?: length)? (?:is )?too long|\b(?:prompt|input)[^:]*?\btoken[s]?\b.*(?:limit|maximum|exceed)/i.test(
      response.reason ?? ''
    )
  );
}

function connectionInterrupted(response: Completion) {
  return (
    response.outcome === 'error' &&
    response.status === 0 &&
    isTransientConnectionError(response.reason ?? '')
  );
}

function termination(response: Completion) {
  if ([401, 403].includes(response.status)) return 'access_denied';
  if (response.status === 429) return 'rate_limited';
  if (/budget.*exceeded/i.test(response.reason ?? ''))
    return 'budget_exhausted';
  if (/timeout|timed out/i.test(response.reason ?? '')) return 'timeout';
  if (response.status === 413) return 'payload_limit';
  return 'request_failed';
}

function challenge(size: number) {
  const facts = Array.from(
    { length: 5 },
    () => `FACT_${randomBytes(10).toString('hex').toUpperCase()}`
  );
  const instruction =
    'Return only a JSON array of every FACT_ marker in the archive.';
  const available = Math.max(
    0,
    size - instruction.length - facts.join('').length - 9
  );
  const filler = randomBytes(Math.ceil((available * 3) / 4))
    .toString('base64')
    .slice(0, available);
  const parts = [facts[0]!];
  for (let index = 0; index < 4; index++) {
    parts.push(
      filler.slice(
        Math.floor((index * available) / 4),
        Math.floor(((index + 1) * available) / 4)
      ),
      facts[index + 1]!
    );
  }
  return { facts, prompt: `${parts.join('\n')}\n${instruction}` };
}

export async function probeContextBoundary(
  input: AuditInput,
  fetch: FetchCompletion
) {
  const started = performance.now();
  const id = 'context_window';
  const reference = input.contextReference;
  const declaredTokens =
    reference?.contextWindowTokens ??
    (reference === null ? undefined : input.capabilities?.contextWindowTokens);
  const reservedOutputTokens =
    input.generation?.maxOutputTokens ??
    Math.min(
      1024,
      reference?.maxOutputTokens ?? 1024,
      declaredTokens === undefined
        ? 1024
        : Math.max(1, Math.floor(declaredTokens / 4))
    );
  const targetInputTokens =
    declaredTokens === undefined
      ? null
      : Math.min(
          reference?.maxInputTokens ?? declaredTokens,
          Math.max(1, declaredTokens - reservedOutputTokens)
        );
  const minimumInputTokens =
    targetInputTokens === null
      ? null
      : targetInputTokens - Math.min(4096, Math.floor(targetInputTokens / 100));
  const maximum = input.contextSearch?.maximumCharacters ?? 4194304;
  const precision = input.contextSearch?.precisionCharacters ?? 4096;
  const maximumRequests =
    input.contextSearch?.maximumRequests ??
    (targetInputTokens === null ? 24 : 5);
  const maxCalibrationCharacters = 32768;
  const calibrationSize =
    targetInputTokens === null
      ? maxCalibrationCharacters
      : Math.max(
          256,
          Math.min(maxCalibrationCharacters, Math.floor(targetInputTokens / 8))
        );
  let size = Math.min(
    maximum,
    input.contextSearch?.initialCharacters ?? calibrationSize
  );
  let largestAcceptedCharacters = 0;
  let largestPassedCharacters = 0;
  let largestAcceptedInputTokens: number | null = null;
  let largestRecalledInputTokens: number | null = null;
  let smallestRejectedCharacters: number | null = null;
  let ambiguousFailure: { size: number; response: Completion } | undefined;
  let firstRecallFailureCharacters: number | null = null;
  let recallIncomplete = false;
  let recallChecked = false;
  let stopReason = 'request_limit';
  let lastResponse: Completion | undefined;
  const trials: Array<Record<string, unknown>> = [];
  const accept = (
    length: number,
    inputTokens: number | null,
    recalled: boolean | null,
    accepted: boolean
  ) => {
    if (
      accepted &&
      (length > largestAcceptedCharacters ||
        (length === largestAcceptedCharacters &&
          largestAcceptedInputTokens === null))
    ) {
      largestAcceptedCharacters = length;
      largestAcceptedInputTokens = inputTokens;
    }
    if (recalled) {
      largestPassedCharacters = Math.max(largestPassedCharacters, length);
      if (inputTokens !== null) {
        largestRecalledInputTokens = Math.max(
          largestRecalledInputTokens ?? 0,
          inputTokens
        );
      }
    }
  };
  while (trials.length < maximumRequests) {
    const { facts, prompt } = challenge(size);
    // The generated prompt is ASCII. Allow for message framing by the endpoint.
    const maximumPlausibleTokens = prompt.length + 256;
    const recordAttempt = async (phase: string) => {
      const response = await requestCompletion(input, fetch, {
        prompt,
        generation: {
          ...input.generation,
          maxOutputTokens: reservedOutputTokens,
        },
      });
      lastResponse = response;
      const accepted =
        ['answer', 'safety_refusal', 'incomplete'].includes(response.outcome) &&
        response.status >= 200 &&
        response.status < 300;
      const markerRecall =
        response.outcome === 'answer'
          ? facts.map((fact, index) => ({
              position: index / (facts.length - 1),
              found: response.text.includes(fact),
            }))
          : null;
      const recalled = markerRecall?.every((marker) => marker.found) ?? null;
      const rejected = contextRejected(response);
      const reported = response.usage.total;
      const tokenUsageInconsistent =
        targetInputTokens !== null &&
        reported !== null &&
        reported > maximumPlausibleTokens;
      trials.push({
        size: prompt.length,
        phase,
        inputBytes: Buffer.byteLength(prompt),
        maxOutputTokens: reservedOutputTokens,
        expectedMarkers: facts,
        expected: {
          requiredMarkers: facts,
          outputFormat: 'JSON array',
          inputCharacters: prompt.length,
        },
        status: response.status,
        outcome: response.outcome,
        accepted,
        recalled,
        markerRecall,
        rejected,
        reportedInputTokens: response.usage.total,
        reason: response.reason,
      });
      accept(
        prompt.length,
        tokenUsageInconsistent ? null : reported,
        recalled,
        accepted
      );
      return { response, accepted, recalled, rejected, tokenUsageInconsistent };
    };
    const attempt = async (phase: string) => {
      const observed = await recordAttempt(phase);
      if (
        connectionInterrupted(observed.response) &&
        trials.length < maximumRequests
      ) {
        return recordAttempt(phase);
      }
      return observed;
    };
    const phase =
      targetInputTokens !== null
        ? trials.length === 0
          ? 'calibration'
          : 'target_verification'
        : smallestRejectedCharacters === null && !ambiguousFailure
          ? 'expansion'
          : 'refinement';
    let observed = await attempt(phase);
    if (
      phase === 'calibration' &&
      observed.tokenUsageInconsistent &&
      prompt.length <= maxCalibrationCharacters &&
      trials.length < maximumRequests
    )
      observed = await recordAttempt('calibration_confirmation');
    if (observed.tokenUsageInconsistent) {
      stopReason = 'token_usage_inconsistent';
      break;
    }
    const reported = observed.response.usage.total;
    const firstRejection = smallestRejectedCharacters === null;
    const atTarget =
      minimumInputTokens !== null &&
      reported !== null &&
      reported >= minimumInputTokens;
    if (observed.rejected) {
      if (trials.length >= maximumRequests) break;
      const confirmation = await attempt('rejection_confirmation');
      if (!confirmation.rejected) {
        stopReason = confirmation.accepted
          ? 'inconsistent_response'
          : termination(confirmation.response);
        break;
      }
      smallestRejectedCharacters = Math.min(
        smallestRejectedCharacters ?? Number.POSITIVE_INFINITY,
        prompt.length
      );
    } else if (observed.accepted) {
      if (atTarget && observed.recalled) {
        stopReason = 'target_verified';
        break;
      }
      if (observed.recalled === null) recallIncomplete = true;
      if (
        observed.recalled === false &&
        (targetInputTokens === null ? !recallChecked : atTarget) &&
        trials.length < maximumRequests
      ) {
        recallChecked = true;
        const confirmation = await attempt('recall_confirmation');
        if (confirmation.recalled === false)
          firstRecallFailureCharacters = prompt.length;
        else recallIncomplete = true;
        if (!confirmation.accepted) {
          stopReason = confirmation.rejected
            ? 'inconsistent_response'
            : termination(confirmation.response);
          break;
        }
        const confirmedTokens = confirmation.response.usage.total;
        if (
          minimumInputTokens !== null &&
          confirmedTokens !== null &&
          confirmedTokens <= maximumPlausibleTokens &&
          confirmedTokens >= minimumInputTokens &&
          confirmation.recalled !== null
        ) {
          stopReason = confirmation.recalled
            ? 'target_verified'
            : 'target_recall_failed';
          break;
        }
      }
      if (targetInputTokens !== null && (reported === null || reported <= 0)) {
        stopReason = 'token_usage_missing';
        break;
      }
      if (atTarget) {
        stopReason = 'target_recall_incomplete';
        break;
      }
    } else if (
      largestAcceptedCharacters > 0 &&
      observed.response.outcome === 'http_error' &&
      observed.response.status === 400 &&
      /^(?:invalid_request_error(?::|$)|request_failed$)/i.test(
        observed.response.reason ?? ''
      )
    ) {
      // Narrow the search without treating a generic error as context evidence.
      ambiguousFailure = { size: prompt.length, response: observed.response };
    } else {
      stopReason = termination(observed.response);
      break;
    }
    if (
      targetInputTokens === null &&
      smallestRejectedCharacters !== null &&
      largestAcceptedCharacters > 0 &&
      smallestRejectedCharacters - largestAcceptedCharacters <= precision
    ) {
      stopReason = 'boundary_located';
      break;
    }
    const searchCeiling = Math.min(
      smallestRejectedCharacters ?? Number.POSITIVE_INFINITY,
      ambiguousFailure?.size ?? Number.POSITIVE_INFINITY
    );
    if (targetInputTokens !== null && minimumInputTokens !== null) {
      const aim = (targetInputTokens + minimumInputTokens) / 2;
      const projected =
        observed.accepted && reported !== null && reported > 0
          ? Math.ceil((prompt.length * aim) / reported)
          : observed.rejected && firstRejection && largestAcceptedCharacters > 0
            ? Math.floor((prompt.length * minimumInputTokens) / aim)
            : Math.floor((largestAcceptedCharacters + searchCeiling) / 2);
      const upper = Math.min(maximum, searchCeiling - 1);
      const next = Math.max(256, Math.min(projected, upper));
      if (next <= largestAcceptedCharacters || next === size || next > upper) {
        stopReason = 'target_not_reached';
        break;
      }
      size = next;
      continue;
    }
    if (Number.isFinite(searchCeiling)) {
      if (
        ambiguousFailure &&
        searchCeiling === ambiguousFailure.size &&
        searchCeiling - largestAcceptedCharacters <= precision
      ) {
        stopReason = termination(ambiguousFailure.response);
        lastResponse = ambiguousFailure.response;
        break;
      }
      size = Math.floor((largestAcceptedCharacters + searchCeiling) / 2);
      if (size < 256) {
        stopReason = 'no_accepted_sample';
        break;
      }
    } else {
      if (size >= maximum) {
        stopReason = 'character_limit';
        break;
      }
      size = Math.min(maximum, size * 2);
    }
  }
  const verifiedTarget = stopReason === 'target_verified';
  const searchComplete = stopReason === 'boundary_located';
  const verificationReason = verifiedTarget
    ? 'target_recalled'
    : targetInputTokens === null
      ? 'reference_missing'
      : stopReason === 'target_recall_failed'
        ? 'recall_missing'
        : stopReason === 'token_usage_missing' ||
            stopReason === 'token_usage_inconsistent'
          ? stopReason
          : stopReason === 'target_recall_incomplete'
            ? 'recall_incomplete'
            : smallestRejectedCharacters !== null
              ? 'context_rejected'
              : 'target_not_reached';
  return result(
    id,
    started,
    {
      measurement: 'endpoint-input-admission',
      capacityStatus:
        largestAcceptedCharacters === 0
          ? 'unmeasured'
          : smallestRejectedCharacters === null
            ? 'lower_bound'
            : 'bounded',
      largestAcceptedCharacters,
      largestAcceptedInputTokens,
      smallestRejectedCharacters,
      largestPassedCharacters,
      smallestFailedCharacters: smallestRejectedCharacters,
      firstRecallFailureCharacters,
      largestRecalledInputTokens,
      recallStatus:
        firstRecallFailureCharacters !== null
          ? 'loss_observed'
          : recallIncomplete || largestPassedCharacters === 0
            ? 'incomplete'
            : 'passed_at_tested_sizes',
      reservedOutputTokens,
      declaredContextWindowTokens: declaredTokens,
      contextVerification: {
        verdict: verifiedTarget ? 'pass' : 'fail',
        reason: verificationReason,
        targetInputTokens,
        minimumInputTokens,
        modelId: reference?.modelId,
        sourceUrl: reference?.sourceUrl,
      },
      searchComplete,
      upperBoundObserved: smallestRejectedCharacters !== null,
      stopReason,
      maximumCharacters: maximum,
      precisionCharacters: precision,
      maximumRequests,
      status: lastResponse?.status,
      reason: lastResponse?.reason,
      trials,
      scope:
        targetInputTokens === null
          ? 'Endpoint input-admission interval in characters with a reserved output budget. Reported input tokens are unverified endpoint usage. Recall performance is recorded separately; no native model token capacity or relay truncation is inferred.'
          : 'Endpoint context verification against the supplied token limit. Input token counts come from the endpoint. Passing requires complete marker recall at the required input size.',
    },
    firstRecallFailureCharacters !== null
      ? [
          finding(
            id,
            'context_recall_missing',
            'Repeated marker loss was observed separately from input admission; it does not establish a context capacity ceiling or its cause.',
            'weak'
          ),
        ]
      : [],
    'completed',
    !verifiedTarget
  );
}
