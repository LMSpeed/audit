import { createHash } from 'node:crypto';
import type { FingerprintBaseline } from '../src/schema/index.js';

export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b))
        )
      : v
  );
export const seal = (baseline: FingerprintBaseline) => {
  const { id: _id, ...content } = baseline;
  baseline.id = createHash('sha256').update(canonical(content)).digest('hex');
  return baseline;
};
export function baselineFixture(): FingerprintBaseline {
  return seal({
    schemaVersion: '1',
    id: '',
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    contract: {
      protocol: 'openai',
      prompts: ['Choose a fingerprint color.', 'Choose a fingerprint animal.'],
      generation: { maxOutputTokens: 128 },
      samplesPerPrompt: 16,
    },
    sources: [
      {
        id: 'a',
        kind: 'candidate',
        training: [{ red: 16 }, { cat: 16 }],
        validation: [{ red: 16 }, { cat: 16 }],
      },
      {
        id: 'b',
        kind: 'candidate',
        training: [{ blue: 16 }, { fox: 16 }],
        validation: [{ blue: 16 }, { fox: 16 }],
      },
      {
        id: 'other',
        kind: 'other',
        training: [{ green: 16 }, { owl: 16 }],
        validation: [{ green: 16 }, { owl: 16 }],
      },
    ],
    calibration: {
      status: 'validated',
      method: 'independent-holdout-v1',
      minimumMargin: 0.1,
      minimumLogLikelihood: { a: -0.5, b: -0.5, other: -0.5 },
      heldOutCorrect: 3,
      heldOutTotal: 3,
    },
  });
}
export const tokenizerFixture = () => ({
  schema: 'tokenizer-bank-v1' as const,
  generated_at: new Date().toISOString(),
  source: {
    tool: 'protocol-contract-fixture',
    archive_manifest_sha256: 'fixture',
    tokenizers: 2,
    candidates: 12,
  },
  wrapper: { prefix: 'TOKENIZER_START\n', suffix: '\nTOKENIZER_END' },
  probes: Array.from({ length: 12 }, (_, j) => ({
    id: String(j),
    category: 'contract',
    text: `TOK_PROBE_${j}`,
  })),
  classes: [
    {
      id: 'alpha',
      lab: 'a',
      lab_name: 'A',
      series: 'a',
      series_zh: 'A',
      members: ['a'],
      aliases: ['^test-model$'],
      counts: [2, 5, 11, 17, 23, 29, 31, 37, 43, 47, 53, 59],
    },
    {
      id: 'beta',
      lab: 'b',
      lab_name: 'B',
      series: 'b',
      series_zh: 'B',
      members: ['b'],
      aliases: ['^reference-b$'],
      counts: [19, 25, 34, 46, 59, 71, 83, 97, 109, 127, 149, 173],
    },
  ],
  api_models: [{ pattern: '^test-model$', vendor: 'fixture', class: 'alpha' }],
});
