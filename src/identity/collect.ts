import { requestCompletion, resolveProtocol } from '../protocols/completion.js';
import { createAuditTransport } from '../protocols/transport.js';
import type {
  AuditOptions,
  FingerprintBaseline,
  FingerprintCollection,
} from '../schema/index.js';
import {
  calibrateFingerprint,
  fingerprintDigest,
  normalizeAnswer,
  validateFingerprintContract,
} from './distribution.js';

export async function collectFingerprintBaseline(
  collection: FingerprintCollection,
  options: AuditOptions = {}
) {
  validateFingerprintContract(collection.contract);
  if (
    collection.sources.length < 3 ||
    collection.sources.filter((source) => source.kind === 'candidate').length <
      2 ||
    !collection.sources.some((source) => source.kind === 'other') ||
    new Set(collection.sources.map((source) => source.id)).size !==
      collection.sources.length ||
    collection.sources.some(
      (source) =>
        !source.id ||
        !source.apiKey ||
        resolveProtocol(source.target) !== collection.contract.protocol
    )
  )
    throw new Error(
      'Collection requires two unique candidate sources and an external reference under one protocol'
    );
  const age = collection.maxAgeDays ?? 7;
  if (!Number.isFinite(age) || age <= 0 || age > 30)
    throw new Error('Baseline age must be between zero and thirty days');
  const transport = createAuditTransport(options);
  const started = Date.now();
  const sources: FingerprintBaseline['sources'] = [];
  const failures: Array<{
    source: string;
    phase: string;
    prompt: number;
    outcome: string;
  }> = [];
  const secrets = collection.sources.map((source) =>
    source.apiKey.toLowerCase()
  );
  try {
    for (const source of collection.sources) {
      const entry: FingerprintBaseline['sources'][number] = {
        id: source.id,
        kind: source.kind,
        training: [],
        validation: [],
      };
      for (const phase of ['training', 'validation'] as const) {
        const cells = collection.contract.prompts.map(
          () => new Map<string, number>()
        );
        sampling: for (
          let round = 0;
          round < collection.contract.samplesPerPrompt;
          round++
        )
          for (const [index, prompt] of collection.contract.prompts.entries()) {
            transport.signal.throwIfAborted();
            const response = await requestCompletion(source, transport.fetch, {
              prompt,
              generation: collection.contract.generation,
            });
            if (
              secrets.some((secret) =>
                response.text.toLowerCase().includes(secret)
              )
            ) {
              failures.push({
                source: source.id,
                phase,
                prompt: index,
                outcome: 'credential_echo',
              });
              break sampling;
            }
            if (
              response.outcome === 'answer' &&
              response.text.trim() &&
              response.text.length <= 2048
            ) {
              const key = normalizeAnswer(response.text);
              cells[index]!.set(key, (cells[index]!.get(key) ?? 0) + 1);
            } else {
              failures.push({
                source: source.id,
                phase,
                prompt: index,
                outcome: response.outcome,
              });
              if (
                ['error', 'http_error', 'unsupported'].includes(
                  response.outcome
                )
              )
                break sampling;
            }
          }
        entry[phase] = cells.map((cell) => Object.fromEntries(cell));
      }
      sources.push(entry);
    }
    transport.signal.throwIfAborted();
    const baseline: FingerprintBaseline = {
      schemaVersion: '1',
      id: '',
      createdAt: new Date(started).toISOString(),
      expiresAt: new Date(started + age * 86400000).toISOString(),
      contract: collection.contract,
      sources,
      calibration: calibrateFingerprint({
        sources,
        contract: collection.contract,
      }),
    };
    baseline.id = fingerprintDigest(baseline);
    return {
      baseline,
      failures,
      usage: { ...transport.usage },
      validation:
        'empirical holdout only; no independent accuracy guarantee or source authentication',
    };
  } finally {
    transport.close();
  }
}
