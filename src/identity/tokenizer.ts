import { finding, result } from '../probes/results.js';
import {
  type FetchCompletion,
  requestCompletion,
} from '../protocols/completion.js';
import type { AuditInput } from '../schema/index.js';
import { assertTokenizerBank, wrapProbe } from './tokenizer-bank.js';
import {
  nextProbes,
  probingDone,
  type TokenizerObservation,
  tokenizerPosterior,
  tokenizerVerdict,
} from './tokenizer-posterior.js';

export async function probeTokenizer(
  input: AuditInput,
  fetch: FetchCompletion
) {
  const id = 'tokenizer_fingerprint';
  const started = performance.now();
  const config = input.tokenizer;
  const abstain = (
    reason: string,
    observations: Record<string, unknown> = {}
  ) =>
    result(
      id,
      started,
      { decision: 'abstain', reason, ...observations },
      [],
      Array.isArray(observations.observations) &&
        observations.observations.length > 0
        ? 'completed'
        : 'skipped',
      true
    );
  if (!config)
    return result(
      id,
      started,
      { decision: 'abstain', reason: 'tokenizer_bank_required' },
      [],
      'unsupported'
    );
  try {
    assertTokenizerBank(config.bank);
  } catch {
    return abstain('invalid_tokenizer_bank');
  }
  const generated = Date.parse(config.bank.generated_at);
  if (
    !Number.isFinite(generated) ||
    generated > Date.now() + 300000 ||
    Date.now() - generated > (config.maxAgeDays ?? 30) * 86400000
  )
    return abstain('stale_tokenizer_bank');
  const observations: TokenizerObservation[] = [];
  const asked = new Set<string>();
  let failed = false;
  const ask = async (probe: string | null) => {
    const text =
      probe === null
        ? ''
        : config.bank.probes.find((item) => item.id === probe)!.text;
    const response = await requestCompletion(input, fetch, {
      prompt: wrapProbe(config.bank, text),
      generation: { maxOutputTokens: 16 },
    });
    if (
      response.status !== 200 ||
      response.usage.total === null ||
      !['answer', 'incomplete'].includes(response.outcome)
    ) {
      failed = true;
      return;
    }
    observations.push({
      probe,
      tokens: response.usage.total,
      ...(response.model ? { responseModel: response.model } : {}),
    });
    if (probe !== null) asked.add(probe);
  };
  await ask(null);
  let posterior = tokenizerPosterior(config.bank, observations);
  const maximum = config.maximumProbes ?? 20;
  while (!failed && posterior && !probingDone(posterior, maximum)) {
    const next = nextProbes(config.bank, posterior, asked, 1)[0];
    if (!next) break;
    await ask(next);
    posterior = tokenizerPosterior(config.bank, observations);
  }
  if (!failed) await ask(null);
  const baselines = observations
    .filter((item) => item.probe === null)
    .map((item) => item.tokens);
  const baselineDrift = new Set(baselines).size > 1;
  const models = new Set(
    observations.map((item) => item.responseModel).filter(Boolean)
  );
  const evidence = {
    observations,
    baselineDrift,
    attribution:
      'Reported tokenizer-count compatibility only; usage may be estimated or modified, and tokenizers are shared across models.',
  };
  if (
    failed ||
    baselines.length !== 2 ||
    baselineDrift ||
    models.size > 1 ||
    !posterior ||
    posterior.answered < 4
  )
    return abstain(
      baselineDrift ? 'baseline_drift' : 'incomplete_measurement',
      evidence
    );
  posterior = tokenizerPosterior(config.bank, observations)!;
  const verdict = tokenizerVerdict(
    config.bank,
    posterior,
    input.target.modelId
  );
  if (
    verdict.kind !== 'exact' ||
    verdict.confidence < 0.99 ||
    verdict.claim?.status === 'uncertain'
  )
    return abstain('unknown_or_uncertain_tokenizer', {
      ...evidence,
      tokenizerVerdict: verdict,
      unknownProbability: posterior.unknown,
    });
  return result(
    id,
    started,
    {
      ...evidence,
      decision: 'exact',
      class: verdict.top.id,
      confidence: verdict.confidence,
      claim: verdict.claim,
    },
    verdict.claim?.status === 'inconsistent'
      ? [
          finding(
            id,
            'tokenizer_claim_mismatch',
            'Reported input-count differences were incompatible with the claimed tokenizer mapping; this is not proof of a different model.',
            'weak'
          ),
        ]
      : []
  );
}
