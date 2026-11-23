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
  const maximum = input.contextSearch?.maximumCharacters ?? 4194304;
  const precision = input.contextSearch?.precisionCharacters ?? 4096;
  const maximumRequests = input.contextSearch?.maximumRequests ?? 24;
  const reservedOutputTokens = input.generation?.maxOutputTokens ?? 1024;
  let size = Math.min(maximum, input.contextSearch?.initialCharacters ?? 32768);
  let largestAcceptedCharacters = 0;
  let largestPassedCharacters = 0;
  let largestAcceptedInputTokens: number | null = null;
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
    response: Completion,
    recalled: boolean | null,
    accepted: boolean
  ) => {
    if (accepted && length > largestAcceptedCharacters) {
      largestAcceptedCharacters = length;
      largestAcceptedInputTokens = response.usage.total;
    }
    if (recalled)
      largestPassedCharacters = Math.max(largestPassedCharacters, length);
  };
  while (trials.length < maximumRequests) {
    const { facts, prompt } = challenge(size);
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
      const recalled =
        response.outcome === 'answer'
          ? facts.every((fact) => response.text.includes(fact))
          : null;
      const rejected = contextRejected(response);
      trials.push({
        size: prompt.length,
        phase,
        inputBytes: Buffer.byteLength(prompt),
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
        rejected,
        reportedInputTokens: response.usage.total,
        reason: response.reason,
      });
      accept(prompt.length, response, recalled, accepted);
      return { response, accepted, recalled, rejected };
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
    const observed = await attempt(
      smallestRejectedCharacters === null && !ambiguousFailure
        ? 'expansion'
        : 'refinement'
    );
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
      if (observed.recalled === null) recallIncomplete = true;
      if (
        observed.recalled === false &&
        !recallChecked &&
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
  const searchComplete = stopReason === 'boundary_located';
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
      recallStatus:
        firstRecallFailureCharacters !== null
          ? 'loss_observed'
          : recallIncomplete || largestPassedCharacters === 0
            ? 'incomplete'
            : 'passed_at_tested_sizes',
      reservedOutputTokens,
      declaredContextWindowTokens: input.capabilities?.contextWindowTokens,
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
        'Endpoint input-admission interval in characters with a reserved output budget. Reported input tokens are unverified endpoint usage. Recall performance is recorded separately; no native model token capacity or relay truncation is inferred.',
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
    !searchComplete || largestAcceptedCharacters === 0
  );
}
