import type { AuditInput } from './index.js';

const positive = (
  value: number | undefined,
  minimum: number,
  maximum: number
) =>
  value === undefined ||
  (Number.isSafeInteger(value) && value >= minimum && value <= maximum);
export function validateDetectorConfiguration(input: AuditInput) {
  const generation = input.generation;
  if (
    generation &&
    (!positive(generation.maxOutputTokens, 1, 65536) ||
      (generation.temperature !== undefined &&
        (!Number.isFinite(generation.temperature) ||
          generation.temperature < 0 ||
          generation.temperature > 2)) ||
      (generation.reasoningEffort !== undefined &&
        !['low', 'medium', 'high'].includes(generation.reasoningEffort)))
  )
    throw new Error('Invalid generation configuration');
  if (input.context) {
    const sizes = input.context.sizes;
    const positions = input.context.positions ?? [0, 0.25, 0.5, 0.75, 1];
    if (
      !Array.isArray(sizes) ||
      !sizes.length ||
      sizes.length > 8 ||
      sizes.some(
        (n, i) => !positive(n, 256, 1000000) || (i > 0 && n <= sizes[i - 1]!)
      ) ||
      !Array.isArray(positions) ||
      positions.length < 2 ||
      positions.length > 8 ||
      positions.some(
        (n, i) =>
          !Number.isFinite(n) ||
          n < 0 ||
          n > 1 ||
          (i > 0 && n <= positions[i - 1]!)
      )
    )
      throw new Error('Invalid context sampling configuration');
  }
  if (
    input.tokenizer &&
    (!positive(input.tokenizer.maximumProbes, 4, 20) ||
      !positive(input.tokenizer.maxAgeDays, 1, 90))
  )
    throw new Error('Invalid tokenizer sampling configuration');
  if (
    input.numericFingerprint &&
    !positive(input.numericFingerprint.maximumAgeDays, 1, 90)
  )
    throw new Error('Invalid numeric reference age');
  for (const endpoint of [input.reference, input.judge])
    if (
      endpoint &&
      (!endpoint.apiKey?.trim() ||
        !endpoint.target?.modelId?.trim() ||
        !endpoint.target.baseUrl ||
        (endpoint.target.protocol !== undefined &&
          !['auto', 'openai', 'anthropic', 'responses'].includes(
            endpoint.target.protocol
          )))
    )
      throw new Error('Invalid reference or judge endpoint');
  if (
    input.judge?.minimumScore !== undefined &&
    (!Number.isFinite(input.judge.minimumScore) ||
      input.judge.minimumScore < 0 ||
      input.judge.minimumScore > 10)
  )
    throw new Error('Invalid judge threshold');
}
