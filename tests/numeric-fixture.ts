import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Synthetic upstream artifact tests real offline scoring integration, not model identification accuracy.
export async function writeNumericFixture(
  directory: string,
  builtAt = new Date().toISOString(),
  modelIds: readonly [string, string] = ['a', 'b']
) {
  const zeros = (n: number) => Array<number>(n).fill(0);
  const params = (sizes: number[]) =>
    sizes.map((n) => ({ mean: zeros(n), scale: Array<number>(n).fill(1) }));
  const bank = (n: number) => ({
    feature_mean: zeros(n),
    feature_scale: Array<number>(n).fill(1),
    nuisance_basis: [],
    centroids: [zeros(n), zeros(n)],
  });
  const artifact = {
    schema: 'shared-detector-v2',
    base_sha256: 'a'.repeat(64),
    source_reference_sha256: 'b'.repeat(64),
    bank_built_at: builtAt,
    model_ids: modelIds,
    response_counts: [8, 8],
    calibration: {
      schema: 'shared-confidence-v2',
      method: 'ranking-temperature',
      tau: 1,
      binding: {
        base_sha256: 'a'.repeat(64),
        reference_sha256: 'b'.repeat(64),
        model_ids: modelIds,
      },
      calibration_run: 'synthetic-contract',
    },
    ranker: {
      head_params: params([355, 74]),
      full_params: params([355, 74]),
      lda_weights: [zeros(429), zeros(429)],
      lda_bias: [0, 0],
      references: [[zeros(429)], [zeros(429)]],
      bank: {
        hellinger: bank(355),
        ordered_blocks: {
          ...bank(74),
          environment_centroids: [[zeros(74), zeros(74)]],
        },
      },
      blend: { frequency: 0.5, positional: 0.5 },
      positional: {
        params: params([355, 74, 102, 220]),
        weights: [zeros(751), zeros(751)],
        bias: [0, 0],
      },
    },
  };
  const header = Buffer.from(JSON.stringify(artifact));
  const binary = Buffer.alloc(Math.ceil((header.length + 4) / 4) * 4);
  binary.writeUInt32LE(header.length);
  header.copy(binary, 4);
  await writeFile(join(directory, 'shared_detector.bin'), binary);
  await writeFile(
    join(directory, 'unified_bank.json'),
    JSON.stringify({
      built_at: builtAt,
      models: modelIds.map((id) => ({
        id,
        display_name: id,
        family: id,
        family_name: id,
        response_count: 8,
      })),
    })
  );
  return createHash('sha256').update(binary).digest('hex');
}
