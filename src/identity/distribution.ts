import { createHash } from 'node:crypto';
import { finding, result } from '../probes/results.js';
import {
  type FetchCompletion,
  requestCompletion,
  resolveProtocol,
} from '../protocols/completion.js';
import type {
  AuditInput,
  FingerprintBaseline,
  FingerprintContract,
} from '../schema/index.js';

export const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === 'object' && item !== null && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        )
      : item
  );
export function fingerprintDigest(
  value: Omit<FingerprintBaseline, 'id'> | FingerprintBaseline
) {
  const { id: _id, ...content } = value as FingerprintBaseline;
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}
const total = (counts: Record<string, number>) =>
  Object.values(counts).reduce((sum, count) => sum + count, 0);
export const normalizeAnswer = (answer: string) => answer.trim().toLowerCase();
export function validateFingerprintContract(contract: FingerprintContract) {
  if (
    !contract ||
    !['openai', 'anthropic', 'responses'].includes(contract.protocol) ||
    !Array.isArray(contract.prompts) ||
    contract.prompts.length < 2 ||
    contract.prompts.length > 8 ||
    contract.prompts.some(
      (prompt) =>
        typeof prompt !== 'string' || !prompt.trim() || prompt.length > 2000
    ) ||
    new Set(contract.prompts).size !== contract.prompts.length ||
    !Number.isSafeInteger(contract.samplesPerPrompt) ||
    contract.samplesPerPrompt < 16 ||
    contract.samplesPerPrompt > 256
  )
    throw new Error('Invalid fingerprint collection contract');
  const generation = contract.generation;
  if (
    !generation ||
    !Number.isSafeInteger(generation.maxOutputTokens) ||
    generation.maxOutputTokens! < 16 ||
    generation.maxOutputTokens! > 2048 ||
    (generation.temperature !== undefined &&
      (!Number.isFinite(generation.temperature) ||
        generation.temperature < 0 ||
        generation.temperature > 2))
  )
    throw new Error('Invalid fingerprint generation contract');
}
export function rankDistributions(
  baseline: Pick<FingerprintBaseline, 'sources' | 'contract'>,
  observed: Array<Record<string, number>>
) {
  return baseline.sources
    .map((source) => {
      let score = 0;
      let samples = 0;
      for (const [index, counts] of observed.entries()) {
        const vocabulary = new Set(
          baseline.sources.flatMap((candidate) =>
            Object.keys(candidate.training[index] ?? {})
          )
        );
        const prior = 1 / (vocabulary.size + 1);
        const training = source.training[index] ?? {};
        const n = total(counts);
        const mass = total(training) + 1;
        for (let j = 0; j < n; j++) score -= Math.log(mass + j);
        const normalized = new Map<string, number>();
        for (const [category, count] of Object.entries(counts)) {
          const key = vocabulary.has(category) ? category : '\u0000';
          normalized.set(key, (normalized.get(key) ?? 0) + count);
        }
        for (const [category, count] of normalized)
          for (let j = 0; j < count; j++)
            score += Math.log(
              (Object.hasOwn(training, category) ? training[category]! : 0) +
                prior +
                j
            );
        samples += n;
      }
      return {
        id: source.id,
        kind: source.kind,
        logLikelihood: samples ? score / samples : -Infinity,
      };
    })
    .sort((a, b) => b.logLikelihood - a.logLikelihood);
}
export function calibrateFingerprint(
  baseline: Pick<FingerprintBaseline, 'sources' | 'contract'>
): FingerprintBaseline['calibration'] {
  const minimumLogLikelihood: Record<string, number | null> = {};
  let heldOutCorrect = 0;
  let minimumMargin = Infinity;
  const expected = baseline.contract.samplesPerPrompt;
  for (const source of baseline.sources) {
    const ranking = rankDistributions(baseline, source.validation);
    const top = ranking[0]!;
    const own = ranking.find((item) => item.id === source.id)!;
    Object.defineProperty(minimumLogLikelihood, source.id, {
      value: Number.isFinite(own.logLikelihood)
        ? own.logLikelihood - 0.25
        : null,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    const complete =
      source.training.length === baseline.contract.prompts.length &&
      source.validation.length === baseline.contract.prompts.length &&
      [...source.training, ...source.validation].every(
        (counts) => total(counts) === expected
      );
    const margin = top.logLikelihood - ranking[1]!.logLikelihood;
    if (complete && top.id === source.id && margin > 0.1) {
      heldOutCorrect++;
      minimumMargin = Math.min(minimumMargin, margin / 2);
    }
  }
  return {
    status:
      heldOutCorrect === baseline.sources.length ? 'validated' : 'insufficient',
    method: 'independent-holdout-v1',
    minimumMargin: Number.isFinite(minimumMargin)
      ? Math.max(0.1, minimumMargin)
      : 0.1,
    minimumLogLikelihood,
    heldOutCorrect,
    heldOutTotal: baseline.sources.length,
  };
}
function baselineError(baseline: FingerprintBaseline): string | null {
  try {
    validateFingerprintContract(baseline.contract);
    if (
      baseline.schemaVersion !== '1' ||
      !Array.isArray(baseline.sources) ||
      baseline.sources.length < 3 ||
      baseline.sources.filter((source) => source.kind === 'candidate').length <
        2 ||
      !baseline.sources.some((source) => source.kind === 'other') ||
      new Set(baseline.sources.map((source) => source.id)).size !==
        baseline.sources.length
    )
      return 'invalid_baseline';
    for (const source of baseline.sources) {
      if (
        !source.id ||
        !['candidate', 'other'].includes(source.kind) ||
        ![source.training, source.validation].every(
          (cells) =>
            Array.isArray(cells) &&
            cells.length === baseline.contract.prompts.length &&
            cells.every(
              (counts) =>
                counts &&
                typeof counts === 'object' &&
                !Array.isArray(counts) &&
                Object.values(counts).every(
                  (count) => Number.isSafeInteger(count) && count >= 0
                ) &&
                total(counts) === baseline.contract.samplesPerPrompt
            )
        )
      )
        return 'insufficient_reference_samples';
    }
    if (baseline.id !== fingerprintDigest(baseline))
      return 'baseline_integrity';
    const created = Date.parse(baseline.createdAt),
      expires = Date.parse(baseline.expiresAt);
    if (
      !Number.isFinite(created) ||
      !Number.isFinite(expires) ||
      created > Date.now() + 300000 ||
      expires <= Date.now() ||
      expires <= created ||
      expires - created > 30 * 86400000
    )
      return 'stale_baseline';
    const calibration = baseline.calibration;
    if (
      calibration?.method !== 'independent-holdout-v1' ||
      calibration.status !== 'validated' ||
      calibration.heldOutCorrect !== calibration.heldOutTotal ||
      calibration.heldOutTotal !== baseline.sources.length ||
      !Number.isFinite(calibration.minimumMargin) ||
      calibration.minimumMargin <= 0 ||
      baseline.sources.some(
        (source) =>
          !Number.isFinite(calibration.minimumLogLikelihood[source.id])
      )
    )
      return 'uncalibrated_baseline';
    if (calibrateFingerprint(baseline).status !== 'validated')
      return 'uncalibrated_baseline';
    return null;
  } catch {
    return 'invalid_baseline';
  }
}
export async function probeModelFingerprint(
  input: AuditInput,
  fetch: FetchCompletion
) {
  const id = 'model_fingerprint';
  const started = performance.now();
  const abstain = (
    reason: string,
    observations: Record<string, unknown> = {}
  ) =>
    result(
      id,
      started,
      { decision: 'abstain', reason, ...observations },
      [],
      typeof observations.acquired === 'number' && observations.acquired > 0
        ? 'completed'
        : 'skipped',
      true
    );
  if (!input.identity) return abstain('baseline_required');
  const { baseline, claimedModel } = input.identity;
  const error = baselineError(baseline);
  if (error) return abstain(error);
  const generation = input.generation ?? baseline.contract.generation;
  if (
    resolveProtocol(input.target) !== baseline.contract.protocol ||
    canonicalJson(generation) !== canonicalJson(baseline.contract.generation) ||
    (input.identity.samplesPerPrompt !== undefined &&
      input.identity.samplesPerPrompt !== baseline.contract.samplesPerPrompt)
  )
    return abstain('incompatible_contract');
  if (
    !baseline.sources.some(
      (source) => source.id === claimedModel && source.kind === 'candidate'
    )
  )
    return abstain('unknown_claim');
  const observed = baseline.contract.prompts.map(
    () => new Map<string, number>()
  );
  const scheduled =
    baseline.contract.prompts.length * baseline.contract.samplesPerPrompt;
  let acquired = 0;
  const failures: Array<{ prompt: number; outcome: string }> = [];
  outer: for (
    let round = 0;
    round < baseline.contract.samplesPerPrompt;
    round++
  ) {
    for (const [index, prompt] of baseline.contract.prompts.entries()) {
      const response = await requestCompletion(input, fetch, {
        prompt,
        generation,
      });
      if (
        response.outcome === 'answer' &&
        response.text.trim() &&
        response.text.length <= 2048
      ) {
        const key = normalizeAnswer(response.text);
        observed[index]!.set(key, (observed[index]!.get(key) ?? 0) + 1);
        acquired++;
      } else {
        failures.push({ prompt: index, outcome: response.outcome });
        if (['error', 'http_error', 'unsupported'].includes(response.outcome))
          break outer;
      }
    }
  }
  const observations = {
    scheduled,
    acquired,
    failures,
    baselineId: baseline.id,
    attribution:
      'Compatibility with collected reference behavior only; not proof of upstream identity, substitution or relay intent.',
  };
  if (acquired !== scheduled)
    return abstain('incomplete_samples', observations);
  const scores = rankDistributions(
    baseline,
    observed.map((counts) => Object.fromEntries(counts))
  );
  const top = scores[0]!;
  if (
    top.kind !== 'candidate' ||
    top.logLikelihood < baseline.calibration.minimumLogLikelihood[top.id]! ||
    top.logLikelihood - scores[1]!.logLikelihood <
      baseline.calibration.minimumMargin
  )
    return abstain('insufficient_fit_or_separation', {
      ...observations,
      scores,
    });
  const match = top.id === claimedModel;
  return result(
    id,
    started,
    {
      ...observations,
      decision: match ? 'reference_match' : 'reference_mismatch',
      candidate: top.id,
      scores,
    },
    match
      ? []
      : [
          finding(
            id,
            'reference_distribution_mismatch',
            `The observed distribution fit reference ${top.id} better than claimed reference ${claimedModel}, subject to the frozen calibration and absolute-fit gates.`,
            'moderate'
          ),
        ]
  );
}
