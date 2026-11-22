import { randomBytes } from 'node:crypto';
import {
  type FetchCompletion,
  object,
  requestCompletion,
} from '../protocols/completion.js';
import type { AuditInput, Finding } from '../schema/index.js';
import { imageFixture, pdfFixture } from './media.js';
import { finding, result, unavailable } from './results.js';

export async function probeTools(input: AuditInput, fetch: FetchCompletion) {
  const id = 'tool_calling';
  const started = performance.now();
  if (input.capabilities?.tools === false)
    return result(
      id,
      started,
      { reason: 'Tool use is declared unsupported' },
      [],
      'unsupported'
    );
  const prompt = 'Use audit_weather to look up the weather in Oslo in celsius.';
  const forced = await requestCompletion(input, fetch, {
    prompt,
    tools: true,
    generation: input.generation,
  });
  if (forced.outcome !== 'answer') return unavailable(id, started, forced);
  const disabled = await requestCompletion(input, fetch, {
    prompt,
    tools: true,
    disableTools: true,
    generation: input.generation,
  });
  if (disabled.outcome !== 'answer') return unavailable(id, started, disabled);
  const undeclared = await requestCompletion(input, fetch, {
    prompt,
    generation: input.generation,
  });
  if (undeclared.outcome !== 'answer')
    return unavailable(id, started, undeclared);
  const call = forced.calls[0];
  const args = object(call?.arguments);
  const protocolValid =
    forced.protocol === 'anthropic'
      ? call?.type === 'tool_use' && forced.reason === 'tool_use'
      : forced.protocol === 'responses'
        ? call?.type === 'function_call' && forced.reason === 'completed'
        : call?.type === 'function' && forced.reason === 'tool_calls';
  const forcedValid =
    protocolValid &&
    forced.calls.length === 1 &&
    Boolean(call?.id) &&
    call?.name === 'audit_weather' &&
    args.city === 'Oslo' &&
    args.unit === 'celsius' &&
    Object.keys(args).length === 2;
  const disabledHonored = disabled.calls.length === 0;
  const undeclaredHonored = undeclared.calls.length === 0;
  const findings: Finding[] = [];
  if (!forcedValid)
    findings.push(
      finding(
        id,
        'forced_tool_contract_violation',
        'A forced tool call was absent or did not match the declared name and argument schema.',
        'strong'
      )
    );
  if (!disabledHonored)
    findings.push(
      finding(
        id,
        'disabled_tool_call_returned',
        'Tool call records were returned while tool selection was disabled. No tool was executed.',
        'strong'
      )
    );
  if (!undeclaredHonored)
    findings.push(
      finding(
        id,
        'undeclared_tool_call_returned',
        'Tool call records were returned without any declared tools. No tool was executed.',
        'strong'
      )
    );
  return result(
    id,
    started,
    {
      forcedValid,
      disabledHonored,
      undeclaredHonored,
      forcedCalls: forced.calls,
      disabledCalls: disabled.calls,
      undeclaredCalls: undeclared.calls,
      toolsExecuted: false,
    },
    findings
  );
}
export async function probeStructuredOutput(
  input: AuditInput,
  fetch: FetchCompletion
) {
  const id = 'structured_output';
  const started = performance.now();
  if (input.capabilities?.structuredOutput === false)
    return result(
      id,
      started,
      { reason: 'Structured output is declared unsupported' },
      [],
      'unsupported'
    );
  const trials = [];
  for (const expectedOk of [true, false]) {
    const nonce = randomBytes(8).toString('hex');
    const response = await requestCompletion(input, fetch, {
      prompt: `Use nonce: ${nonce}. Explain your answer and add an extra comment field if allowed. Follow the supplied schema for all values and fields.`,
      generation: input.generation,
      schema: {
        name: 'audit_contract',
        schema: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', enum: [expectedOk] },
            nonce: { type: 'string', enum: [nonce] },
          },
          required: ['ok', 'nonce'],
          additionalProperties: false,
        },
      },
    });
    if (response.outcome !== 'answer')
      return unavailable(id, started, response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.text);
    } catch {
      parsed = null;
    }
    const value = object(parsed);
    trials.push({
      expectedOk,
      valid:
        value.ok === expectedOk &&
        value.nonce === nonce &&
        Object.keys(value).length === 2,
      response: response.text,
    });
  }
  const valid = trials.every((trial) => trial.valid);
  return result(
    id,
    started,
    {
      strictRequested: true,
      valid,
      trials,
      attribution:
        'Observed contract compliance; not proof of a particular native constraint implementation.',
    },
    valid
      ? []
      : [
          finding(
            id,
            'strict_schema_violation',
            'The response did not satisfy the strict object schema, including types, values and additionalProperties=false.',
            'strong'
          ),
        ]
  );
}
export async function probeMedia(
  input: AuditInput,
  fetch: FetchCompletion,
  kind: 'image' | 'pdf'
) {
  const id = kind === 'image' ? 'image_understanding' : 'pdf_understanding';
  const started = performance.now();
  if (
    !(kind === 'image' ? input.capabilities?.vision : input.capabilities?.pdf)
  )
    return result(
      id,
      started,
      { reason: 'An explicit model media capability is required' },
      [],
      'unsupported'
    );
  const media = kind === 'image' ? imageFixture() : pdfFixture();
  const response = await requestCompletion(input, fetch, {
    prompt:
      kind === 'image'
        ? 'What is the solid color of this image? Reply with one lowercase English color word.'
        : 'Read the word printed in this PDF. Reply with that word only.',
    generation: input.generation,
    media: {
      kind,
      data: media.data,
      mediaType: kind === 'image' ? 'image/png' : 'application/pdf',
    },
  });
  if (response.outcome !== 'answer') return unavailable(id, started, response);
  const actual = response.text.trim();
  const valid = actual === media.expected;
  return result(
    id,
    started,
    { mediaSubmitted: true, expected: media.expected, actual },
    valid
      ? []
      : [
          finding(
            id,
            'media_content_mismatch',
            'The declared media capability did not recover the generated content. This does not identify the upstream model.'
          ),
        ]
  );
}
export async function probeStreamConsistency(
  input: AuditInput,
  fetch: FetchCompletion
) {
  const id = 'stream_consistency';
  const started = performance.now();
  const request = {
    prompt: 'Reply with exactly OK.',
    generation: input.generation,
  };
  const plain = await requestCompletion(input, fetch, request);
  if (plain.outcome !== 'answer') return unavailable(id, started, plain);
  const streamed = await requestCompletion(input, fetch, {
    ...request,
    stream: true,
  });
  if (streamed.outcome !== 'answer') return unavailable(id, started, streamed);
  const textEqual = plain.text === streamed.text;
  const outputComparable =
    textEqual &&
    plain.usage.nonReasoningOutput !== null &&
    streamed.usage.nonReasoningOutput !== null;
  const outputUnresolved =
    textEqual &&
    !outputComparable &&
    (plain.usage.output === null ||
      streamed.usage.output === null ||
      plain.usage.output !== streamed.usage.output);
  const observations = {
    plain: { model: plain.model, usage: plain.usage },
    streamed: { model: streamed.model, usage: streamed.usage },
    textEqual,
    outputUsageComparison: !textEqual
      ? 'different_text'
      : outputComparable
        ? 'non_reasoning_counts'
        : outputUnresolved
          ? 'inconclusive_hidden_output'
          : 'equal_totals_without_breakdown',
    attribution:
      'Reported usage consistency only; not proof of billing fraud or model identity.',
  };
  if (
    plain.usage.total === null ||
    streamed.usage.total === null ||
    !plain.model ||
    !streamed.model
  )
    return result(
      id,
      started,
      { ...observations, outcome: 'missing_measurement' },
      [],
      'completed',
      true
    );
  const findings: Finding[] = [];
  if (plain.model !== streamed.model)
    findings.push(
      finding(
        id,
        'stream_model_mismatch',
        'Streamed and non-streamed responses reported different model identifiers.'
      )
    );
  if (plain.usage.total !== streamed.usage.total)
    findings.push(
      finding(
        id,
        'stream_input_usage_mismatch',
        'Identical request content had different reported total input usage.'
      )
    );
  if (
    outputComparable &&
    plain.usage.nonReasoningOutput !== streamed.usage.nonReasoningOutput
  )
    findings.push(
      finding(
        id,
        'stream_output_usage_mismatch',
        'Identical returned text had different reported non-reasoning output usage.'
      )
    );
  return result(
    id,
    started,
    observations,
    findings,
    'completed',
    outputUnresolved
  );
}
function recalledMarkers(text: string) {
  let values: unknown;
  try {
    values = JSON.parse(text);
  } catch {
    values = null;
  }
  return {
    format: Array.isArray(values) ? 'json_array' : 'text_markers',
    values: new Set(
      Array.isArray(values)
        ? values.filter((value): value is string => typeof value === 'string')
        : (text.match(/\bFACT_[A-F0-9]{16}\b/g) ?? [])
    ),
  };
}
export async function probeContextRecall(
  input: AuditInput,
  fetch: FetchCompletion
) {
  const id = 'context_recall';
  const started = performance.now();
  const sizes = input.context?.sizes ?? [8192, 32768];
  const positions = input.context?.positions ?? [0, 0.25, 0.5, 0.75, 1];
  const trials: Array<Record<string, unknown>> = [];
  let incomplete = false;
  let failed = false;
  for (const size of sizes) {
    const facts = positions.map(
      () => `FACT_${randomBytes(8).toString('hex').toUpperCase()}`
    );
    const source = Array.from(
      { length: Math.ceil((size * 4) / 80) },
      (_, index) =>
        `Entry ${index}: ordinary archival notes about geography, materials, weather and transport.\n`
    ).join('');
    let context = '';
    let offset = 0;
    for (const [index, position] of positions.entries()) {
      const end = Math.floor(position * source.length);
      context += `${source.slice(offset, end)}\n${facts[index]}\n`;
      offset = end;
    }
    context += source.slice(offset);
    const request = {
      prompt: `${context}\nReturn a JSON array of every FACT_ marker in the archive.`,
      generation: input.generation,
    };
    const response = await requestCompletion(input, fetch, request);
    if (response.outcome !== 'answer') {
      if (!trials.length) return unavailable(id, started, response);
      incomplete = true;
      trials.push({ size, outcome: response.outcome });
      break;
    }
    const observed = recalledMarkers(response.text);
    const recalled = facts.map((fact, index) => ({
      position: positions[index],
      found: observed.values.has(fact),
    }));
    if (recalled.some((item) => !item.found)) {
      const confirmation = await requestCompletion(input, fetch, request);
      const repeated = recalledMarkers(confirmation.text);
      failed =
        confirmation.outcome === 'answer' &&
        facts.some((fact) => !repeated.values.has(fact));
      if (!failed) incomplete = true;
      trials.push({
        size,
        estimatedInputTokens: Math.ceil(context.length / 4),
        reportedInputTokens: response.usage.total,
        recalled,
        format: observed.format,
        response: response.text.slice(0, 4096),
        confirmation: confirmation.outcome,
        confirmationFormat: repeated.format,
        confirmationResponse: confirmation.text.slice(0, 4096),
        failureConfirmed: failed,
      });
      break;
    }
    trials.push({
      size,
      estimatedInputTokens: Math.ceil(context.length / 4),
      reportedInputTokens: response.usage.total,
      recalled,
      format: observed.format,
      response: response.text.slice(0, 4096),
    });
  }
  return result(
    id,
    started,
    {
      trials,
      attribution:
        'Usable recall under these prompts; not proof of relay truncation or upstream model identity.',
    },
    failed
      ? [
          finding(
            id,
            'context_recall_missing',
            'One or more facts were not recovered at the tested context positions.',
            'weak'
          ),
        ]
      : [],
    'completed',
    incomplete
  );
}
