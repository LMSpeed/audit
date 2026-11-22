import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { generateChallenges, loadDetector } from 'lmfpd-sdk';
import { result } from '../probes/results.js';
import {
  type FetchCompletion,
  requestCompletion,
} from '../protocols/completion.js';
import type { AuditInput } from '../schema/index.js';
import { loadBundledNumericReference } from './bundled-references.js';

export async function probeNumericFingerprint(
  input: AuditInput,
  fetch: FetchCompletion
) {
  const id = 'numeric_fingerprint';
  const started = performance.now();
  let acquired = 0;
  let reference: Record<string, string> | undefined;
  const abstain = (
    reason: string,
    observations: Record<string, unknown> = {}
  ) =>
    result(
      id,
      started,
      {
        decision: 'abstain',
        reason,
        acquired,
        ...(reference ? { reference } : {}),
        ...observations,
      },
      [],
      acquired > 0 ? 'completed' : 'skipped',
      true
    );
  let config = input.numericFingerprint;
  if (!config && input.referenceData !== 'disabled') {
    try {
      const bundled = await loadBundledNumericReference();
      config = bundled.configuration;
      reference = bundled.provenance;
    } catch (error) {
      return abstain('bundled_numeric_reference_unavailable', {
        error:
          error instanceof Error ? error.message : 'Reference loading failed',
      });
    }
  }
  if (!config) return abstain('numeric_reference_required');
  if (
    !isAbsolute(config.dataDirectory) ||
    !/^[a-f0-9]{64}$/.test(config.detectorSha256)
  )
    return abstain('invalid_numeric_reference');
  try {
    const bytes = await readFile(
      join(config.dataDirectory, 'shared_detector.bin')
    );
    if (
      createHash('sha256').update(bytes).digest('hex') !== config.detectorSha256
    )
      return abstain('numeric_artifact_integrity');
    // A local directory disables the dependency's remote fetching and background refresh path.
    const detector = await loadDetector({ source: config.dataDirectory });
    const builtAt = Date.parse(detector.builtAt);
    if (
      !Number.isFinite(builtAt) ||
      builtAt > Date.now() + 300000 ||
      Date.now() - builtAt > (config.maximumAgeDays ?? 30) * 86400000
    )
      return abstain('stale_numeric_reference', {
        builtAt: detector.builtAt,
        maximumAgeDays: config.maximumAgeDays ?? 30,
      });
    const bank = JSON.parse(
      await readFile(join(config.dataDirectory, 'unified_bank.json'), 'utf8')
    ) as { models: Array<{ id: string; response_count: number }> };
    const modelId = input.target.modelId
      .trim()
      .toLowerCase()
      .replace(/^.*\//, '')
      .replace(/:.*$/, '');
    if (
      !bank.models.some(
        (model) =>
          model.id.toLowerCase() === modelId && model.response_count > 0
      )
    )
      return abstain('numeric_model_reference_missing', {
        modelId: input.target.modelId,
      });
    const challenges = generateChallenges();
    const outputs = [];
    for (const challenge of challenges) {
      const response = await requestCompletion(input, fetch, {
        prompt: challenge.prompt,
        generation: {
          ...input.generation,
          maxOutputTokens: input.generation?.maxOutputTokens ?? 8192,
        },
      });
      if (response.outcome !== 'answer')
        return abstain('incomplete_numeric_samples', {
          outcome: response.outcome,
          acquired: outputs.length,
        });
      outputs.push({
        text: response.text,
        expected_count: challenge.expected_count,
      });
      acquired++;
    }
    const analysis = detector.analyze(outputs, { strict: true });
    if (
      analysis.decision !== 'scored' ||
      analysis.probability_status !== 'reference_calibrated'
    )
      return abstain('unscorable_or_uncalibrated', { analysis });
    return result(
      id,
      started,
      {
        decision: 'ranked',
        scope: 'reference-closed-set',
        candidates: analysis.results,
        diagnostics: analysis.diagnostics,
        sequence: analysis.sequence,
        calibration: analysis.calibration,
        detectorSha256: config.detectorSha256,
        builtAt: detector.builtAt,
        ...(reference ? { reference } : {}),
        attribution:
          'Closed-set ranking only. Unlisted models may rank highly; no identity pass or model-substitution finding is issued.',
      },
      [],
      'completed',
      true
    );
  } catch (error) {
    return abstain('numeric_reference_or_scoring_error', {
      error: error instanceof Error ? error.message : 'Scoring failed',
    });
  }
}
