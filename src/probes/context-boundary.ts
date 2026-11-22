import { randomBytes } from 'node:crypto';
import {
  type FetchCompletion,
  requestCompletion,
} from '../protocols/completion.js';
import type { AuditInput } from '../schema/index.js';
import { finding, result } from './results.js';

export async function probeContextBoundary(
  input: AuditInput,
  fetch: FetchCompletion
) {
  const started = performance.now();
  const id = 'context_window';
  const maximum = 524288;
  const precision = 4096;
  let largestPassedCharacters = 0;
  let smallestFailedCharacters: number | null = null;
  let incomplete = false;
  let recallFailure = false;
  const trials: Array<Record<string, unknown>> = [];
  let size = 4096;
  while (trials.length < 12) {
    const facts = Array.from(
      { length: 3 },
      () => `FACT_${randomBytes(10).toString('hex').toUpperCase()}`
    );
    const instruction =
      '\nReturn a JSON array of every FACT_ marker in the archive.';
    const filler =
      'Ordinary archival notes about geography, weather and transport.\n';
    const available = Math.max(
      0,
      size - instruction.length - facts.join('').length - 4
    );
    const text = filler
      .repeat(Math.ceil(available / filler.length))
      .slice(0, available);
    const halfway = Math.floor(text.length / 2);
    const prompt = `${facts[0]}\n${text.slice(0, halfway)}\n${facts[1]}\n${text.slice(halfway)}\n${facts[2]}${instruction}`;
    const attempt = async () => {
      const response = await requestCompletion(input, fetch, {
        prompt,
        generation: { ...input.generation, maxOutputTokens: 256 },
      });
      const recalled =
        response.outcome === 'answer' &&
        facts.every((fact) => response.text.includes(fact));
      const rejected =
        response.outcome === 'http_error' &&
        [400, 413, 422].includes(response.status) &&
        /context|token.*limit|prompt.*long|input.*long|input.*large/i.test(
          response.reason ?? ''
        );
      return { response, recalled, rejected };
    };
    let observed = await attempt();
    let confirmed = false;
    if (
      !observed.recalled &&
      (observed.rejected || observed.response.outcome === 'answer') &&
      trials.length < 11
    ) {
      const confirmation = await attempt();
      trials.push({
        size: prompt.length,
        phase: 'confirmation',
        expectedMarkers: facts,
        status: confirmation.response.status,
        outcome: confirmation.response.outcome,
        recalled: confirmation.recalled,
        rejected: confirmation.rejected,
      });
      confirmed =
        (observed.rejected && confirmation.rejected) ||
        (observed.response.outcome === 'answer' &&
          confirmation.response.outcome === 'answer' &&
          !confirmation.recalled);
      if (confirmed && !observed.rejected) recallFailure = true;
      if (!confirmed) {
        incomplete = true;
        observed = confirmation;
      }
    }
    trials.push({
      size: prompt.length,
      expectedMarkers: facts,
      status: observed.response.status,
      outcome: observed.response.outcome,
      recalled: observed.recalled,
      rejected: observed.rejected,
      confirmed,
      reportedInputTokens: observed.response.usage.total,
      reason: observed.response.reason,
    });
    if (incomplete) break;
    if (observed.recalled)
      largestPassedCharacters = Math.max(
        largestPassedCharacters,
        prompt.length
      );
    else if (confirmed)
      smallestFailedCharacters = Math.min(
        smallestFailedCharacters ?? Number.POSITIVE_INFINITY,
        prompt.length
      );
    else {
      incomplete = true;
      break;
    }
    if (smallestFailedCharacters !== null) {
      if (smallestFailedCharacters - largestPassedCharacters <= precision)
        break;
      size = Math.floor(
        (smallestFailedCharacters + largestPassedCharacters) / 2
      );
    } else {
      if (size >= maximum) break;
      size = Math.min(maximum, size * 2);
    }
  }
  const searchComplete =
    !incomplete &&
    (smallestFailedCharacters !== null
      ? smallestFailedCharacters - largestPassedCharacters <= precision
      : largestPassedCharacters >= maximum);
  return result(
    id,
    started,
    {
      trials,
      largestPassedCharacters,
      smallestFailedCharacters,
      searchComplete,
      upperBoundObserved: smallestFailedCharacters !== null,
      maximumCharacters: maximum,
      precisionCharacters: precision,
      scope:
        'Automatically measured usable input/recall interval in characters; token capacity is not inferred and failures are not attributed to relay truncation.',
    },
    recallFailure
      ? [
          finding(
            id,
            'context_recall_missing',
            'Repeated marker loss was observed while locating the usable context interval; the cause is not established.',
            'weak'
          ),
        ]
      : [],
    'completed',
    !searchComplete || largestPassedCharacters === 0
  );
}
