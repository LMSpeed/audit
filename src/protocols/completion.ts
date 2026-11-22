import type { AuditInput, AuditTarget } from '../schema/index.js';

export type JsonRecord = Record<string, unknown>;
export const object = (value: unknown): JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
export const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
export type ResolvedProtocol = 'openai' | 'anthropic' | 'responses';
export const resolveProtocol = (target: AuditTarget): ResolvedProtocol =>
  target.protocol && target.protocol !== 'auto'
    ? target.protocol
    : /claude/i.test(target.modelId)
      ? 'anthropic'
      : 'openai';
export type ReportedUsage = {
  ordinary: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  total: number | null;
  output: number | null;
  reasoning: number | null;
  nonReasoningOutput: number | null;
};
export function reportedUsage(
  value: unknown,
  protocol: ResolvedProtocol
): ReportedUsage {
  const usage = object(value);
  const output = count(
    protocol === 'openai' ? usage.completion_tokens : usage.output_tokens
  );
  const outputDetails = object(
    protocol === 'openai'
      ? usage.completion_tokens_details
      : usage.output_tokens_details
  );
  const reasoning = count(
    protocol === 'anthropic' && Object.hasOwn(outputDetails, 'thinking_tokens')
      ? outputDetails.thinking_tokens
      : outputDetails.reasoning_tokens
  );
  const outputUsage = {
    output,
    reasoning,
    nonReasoningOutput:
      output !== null && reasoning !== null && reasoning <= output
        ? output - reasoning
        : null,
  };
  if (protocol === 'anthropic') {
    const ordinary = count(usage.input_tokens);
    const cacheRead = count(
      Object.hasOwn(usage, 'cache_read_input_tokens')
        ? usage.cache_read_input_tokens
        : 0
    );
    const cacheWrite = count(
      Object.hasOwn(usage, 'cache_creation_input_tokens')
        ? usage.cache_creation_input_tokens
        : 0
    );
    return {
      ordinary,
      cacheRead,
      cacheWrite,
      total:
        ordinary !== null && cacheRead !== null && cacheWrite !== null
          ? ordinary + cacheRead + cacheWrite
          : null,
      ...outputUsage,
    };
  }
  const total = count(
    protocol === 'responses' ? usage.input_tokens : usage.prompt_tokens
  );
  const details = object(
    protocol === 'responses'
      ? usage.input_tokens_details
      : usage.prompt_tokens_details
  );
  const cacheRead = count(details.cached_tokens);
  const cacheWrite = count(
    Object.hasOwn(details, 'cache_write_tokens')
      ? details.cache_write_tokens
      : 0
  );
  return {
    ordinary:
      total !== null &&
      cacheRead !== null &&
      cacheWrite !== null &&
      cacheRead + cacheWrite <= total
        ? total - cacheRead - cacheWrite
        : null,
    cacheRead,
    cacheWrite,
    total,
    ...outputUsage,
  };
}
export type CompletionOutcome =
  | 'answer'
  | 'safety_refusal'
  | 'unexpected_stream'
  | 'unsupported'
  | 'http_error'
  | 'unparseable'
  | 'incomplete'
  | 'error';
export type Completion = {
  outcome: CompletionOutcome;
  status: number;
  protocol: ResolvedProtocol;
  text: string;
  model: string | null;
  usage: ReportedUsage;
  calls: Array<{ id: string; name: string; arguments: unknown; type: string }>;
  reason?: string;
};
export type CompletionRequest = {
  prompt: string;
  system?: string;
  stream?: boolean;
  generation?: AuditInput['generation'];
  tools?: boolean;
  disableTools?: boolean;
  schema?: { name: string; schema: JsonRecord };
  media?: { kind: 'image' | 'pdf'; data: string; mediaType: string };
};
export type FetchCompletion = (
  url: string | URL,
  init?: RequestInit
) => Promise<Response>;
const parse = (value: string): unknown => {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
};
export function completionBody(
  target: AuditTarget,
  request: CompletionRequest
): JsonRecord {
  const protocol = resolveProtocol(target);
  const generation = request.generation ?? {};
  const textType = protocol === 'responses' ? 'input_text' : 'text';
  const blocks: JsonRecord[] = [{ type: textType, text: request.prompt }];
  const media = request.media;
  if (media) {
    const uri = `data:${media.mediaType};base64,${media.data}`;
    blocks.unshift(
      protocol === 'anthropic'
        ? {
            type: media.kind === 'image' ? 'image' : 'document',
            source: {
              type: 'base64',
              media_type: media.mediaType,
              data: media.data,
            },
          }
        : protocol === 'responses'
          ? media.kind === 'image'
            ? { type: 'input_image', image_url: uri }
            : { type: 'input_file', filename: 'probe.pdf', file_data: uri }
          : media.kind === 'image'
            ? { type: 'image_url', image_url: { url: uri } }
            : { type: 'file', file: { filename: 'probe.pdf', file_data: uri } }
    );
  }
  const messages: JsonRecord[] = [
    { role: 'user', content: media ? blocks : request.prompt },
  ];
  if (request.system && protocol !== 'anthropic')
    messages.unshift({ role: 'system', content: request.system });
  const body: JsonRecord = {
    model: target.modelId,
    stream: request.stream ?? false,
    ...(generation.temperature !== undefined
      ? { temperature: generation.temperature }
      : {}),
  };
  if (protocol === 'responses')
    Object.assign(body, {
      input: messages,
      store: false,
      max_output_tokens: generation.maxOutputTokens ?? 256,
      ...(generation.reasoningEffort
        ? { reasoning: { effort: generation.reasoningEffort } }
        : {}),
    });
  else
    Object.assign(body, {
      messages,
      max_tokens: generation.maxOutputTokens ?? 256,
      ...(protocol === 'anthropic'
        ? { ...(request.system ? { system: request.system } : {}) }
        : {
            ...(request.stream
              ? { stream_options: { include_usage: true } }
              : {}),
            ...(generation.reasoningEffort
              ? { reasoning_effort: generation.reasoningEffort }
              : {}),
          }),
    });
  if (request.tools) {
    const schema = {
      type: 'object',
      properties: {
        city: { type: 'string', enum: ['Oslo'] },
        unit: { type: 'string', enum: ['celsius'] },
      },
      required: ['city', 'unit'],
      additionalProperties: false,
    };
    const fn = {
      name: 'audit_weather',
      description: 'Look up weather for the given city and temperature unit.',
      parameters: schema,
      strict: true,
    };
    if (protocol === 'anthropic')
      Object.assign(body, {
        tools: [
          { name: fn.name, description: fn.description, input_schema: schema },
        ],
        tool_choice: {
          type: request.disableTools ? 'none' : 'tool',
          ...(request.disableTools ? {} : { name: fn.name }),
        },
      });
    else
      Object.assign(body, {
        tools: [
          protocol === 'responses'
            ? { type: 'function', ...fn }
            : { type: 'function', function: fn },
        ],
        tool_choice: request.disableTools
          ? 'none'
          : protocol === 'responses'
            ? { type: 'function', name: fn.name }
            : { type: 'function', function: { name: fn.name } },
        parallel_tool_calls: false,
      });
  }
  if (request.schema) {
    const schema = { type: 'json_schema', ...request.schema, strict: true };
    if (protocol === 'anthropic')
      body.output_config = {
        format: { type: 'json_schema', schema: request.schema.schema },
      };
    else if (protocol === 'responses') body.text = { format: schema };
    else
      body.response_format = {
        type: 'json_schema',
        json_schema: { ...request.schema, strict: true },
      };
  }
  return body;
}
export function fromEnvelope(
  value: unknown,
  protocol: ResolvedProtocol,
  status: number
): Completion {
  const root = object(value);
  const result: Completion = {
    outcome: 'answer',
    status,
    protocol,
    text: '',
    model: typeof root.model === 'string' ? root.model : null,
    usage: reportedUsage(root.usage, protocol),
    calls: [],
  };
  let reason: unknown;
  let refusal = false;
  if (protocol === 'anthropic') {
    reason = root.stop_reason;
    for (const block of array(root.content).map(object)) {
      if (block.type === 'text' && typeof block.text === 'string')
        result.text += block.text;
      if (block.type === 'tool_use')
        result.calls.push({
          id: String(block.id ?? ''),
          name: String(block.name ?? ''),
          arguments: block.input,
          type: 'tool_use',
        });
    }
  } else if (protocol === 'responses') {
    reason = root.status;
    for (const item of array(root.output).map(object)) {
      if (item.type === 'function_call')
        result.calls.push({
          id: String(item.call_id ?? ''),
          name: String(item.name ?? ''),
          arguments: parse(String(item.arguments ?? '')),
          type: 'function_call',
        });
      for (const block of array(item.content).map(object)) {
        if (block.type === 'refusal') refusal = true;
        if (block.type === 'output_text' && typeof block.text === 'string')
          result.text += block.text;
      }
    }
    if (reason !== 'completed') result.outcome = 'incomplete';
  } else {
    const choice = object(array(root.choices)[0]);
    const message = object(choice.message);
    reason = choice.finish_reason;
    refusal = Boolean(message.refusal);
    if (typeof message.content === 'string') result.text = message.content;
    for (const call of array(message.tool_calls).map(object)) {
      const fn = object(call.function);
      result.calls.push({
        id: String(call.id ?? ''),
        name: String(fn.name ?? ''),
        arguments: parse(String(fn.arguments ?? '')),
        type: String(call.type ?? ''),
      });
    }
    if (message.function_call) {
      const fn = object(message.function_call);
      result.calls.push({
        id: '',
        name: String(fn.name ?? ''),
        arguments: parse(String(fn.arguments ?? '')),
        type: 'legacy_function_call',
      });
    }
  }
  if (refusal || ['refusal', 'content_filter'].includes(String(reason)))
    result.outcome = 'safety_refusal';
  else if (['max_tokens', 'length'].includes(String(reason)))
    result.outcome = 'incomplete';
  else if (!result.text.trim() && !result.calls.length)
    result.outcome = 'unparseable';
  if (typeof reason === 'string') result.reason = reason;
  return result;
}
function mergeUsage(previous: JsonRecord, next: JsonRecord): JsonRecord {
  const merged = { ...previous };
  for (const [key, value] of Object.entries(next)) {
    if (value == null) continue;
    merged[key] =
      typeof value === 'object' && !Array.isArray(value)
        ? mergeUsage(object(previous[key]), object(value))
        : value;
  }
  return merged;
}
export function parseCompletionStream(
  raw: string,
  protocol: ResolvedProtocol,
  status = 200
): Completion {
  let usage: JsonRecord = {};
  let model: unknown;
  let text = '';
  let finish: unknown;
  let terminal = false;
  let invalid = false;
  let envelope: unknown;
  let refusal = false;
  let stopped = false;
  for (const frame of raw.replace(/\r\n/g, '\n').split('\n\n')) {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data) continue;
    if (data === '[DONE]') {
      terminal = true;
      stopped = true;
      continue;
    }
    const value = parse(data);
    if (!value) {
      invalid = true;
      continue;
    }
    const event = object(value);
    if (stopped) invalid = true;
    if (event.type === 'error' || /failed|incomplete/.test(String(event.type)))
      invalid = true;
    if (protocol === 'responses') {
      if (event.type === 'response.created')
        model = object(event.response).model;
      if (event.type === 'response.completed') {
        envelope = event.response;
        terminal = true;
        stopped = true;
      }
    } else if (protocol === 'anthropic') {
      if (event.type === 'message_start') {
        const message = object(event.message);
        model = message.model;
        usage = { ...object(message.usage) };
      }
      if (event.type === 'content_block_delta') {
        const delta = object(event.delta);
        if (delta.type === 'text_delta') text += String(delta.text ?? '');
      }
      if (event.type === 'message_delta') {
        usage = mergeUsage(usage, object(event.usage));
        finish = object(event.delta).stop_reason;
      }
      if (event.type === 'message_stop') {
        terminal = true;
        stopped = true;
      }
    } else {
      if (event.model !== undefined) {
        if (model !== undefined && model !== event.model) invalid = true;
        model = event.model;
      }
      usage = mergeUsage(usage, object(event.usage));
      const choice = object(array(event.choices)[0]);
      const delta = object(choice.delta);
      if (typeof delta.content === 'string') text += delta.content;
      if (delta.refusal) refusal = true;
      if (choice.finish_reason) finish = choice.finish_reason;
    }
  }
  const result =
    protocol === 'responses'
      ? fromEnvelope(envelope, protocol, status)
      : fromEnvelope(
          protocol === 'anthropic'
            ? {
                model,
                usage,
                content: [{ type: 'text', text }],
                stop_reason: finish,
              }
            : {
                model,
                usage,
                choices: [
                  {
                    message: { content: text, refusal: refusal || undefined },
                    finish_reason: finish,
                  },
                ],
              },
          protocol,
          status
        );
  if (!terminal || invalid || (protocol !== 'responses' && !finish))
    result.outcome = 'incomplete';
  return result;
}
export async function requestCompletion(
  endpoint: { target: AuditTarget; apiKey: string },
  fetch: FetchCompletion,
  request: CompletionRequest
): Promise<Completion> {
  const protocol = resolveProtocol(endpoint.target);
  const fail = (
    outcome: CompletionOutcome,
    status = 0,
    reason?: string
  ): Completion => ({
    outcome,
    status,
    protocol,
    text: '',
    model: null,
    usage: reportedUsage({}, protocol),
    calls: [],
    reason,
  });
  try {
    const response = await fetch(
      `${endpoint.target.baseUrl.replace(/\/$/, '')}/${protocol === 'anthropic' ? 'messages' : protocol === 'responses' ? 'responses' : 'chat/completions'}`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(protocol === 'anthropic'
            ? {
                'x-api-key': endpoint.apiKey,
                'anthropic-version': '2023-06-01',
              }
            : { authorization: `Bearer ${endpoint.apiKey}` }),
        },
        body: JSON.stringify(completionBody(endpoint.target, request)),
      }
    );
    const raw = await response.text();
    if (!response.ok) {
      const error = object(object(parse(raw)).error);
      const unsupported =
        [400, 404, 422].includes(response.status) &&
        /unsupported|not support|unknown parameter|unrecognized|unknown endpoint/i.test(
          String(error.message ?? '')
        );
      return fail(
        unsupported ? 'unsupported' : 'http_error',
        response.status,
        [error.type ?? error.code ?? 'request_failed', error.message]
          .filter((value) => typeof value === 'string')
          .join(': ')
          .slice(0, 512)
      );
    }
    const isStream =
      response.headers.get('content-type')?.split(';')[0]?.trim() ===
        'text/event-stream' ||
      /^(?:\s|:[^\n]*\n)*(?:event:|data:)/.test(raw.slice(0, 2048));
    if (request.stream)
      return isStream
        ? parseCompletionStream(raw, protocol, response.status)
        : fail('unparseable', response.status, 'expected_stream');
    if (isStream) return fail('unexpected_stream', response.status);
    const parsed = parse(raw);
    if (!parsed || !Object.keys(object(parsed)).length)
      return fail('unparseable', response.status);
    return fromEnvelope(parsed, protocol, response.status);
  } catch (error) {
    return fail(
      'error',
      0,
      error instanceof Error ? error.message : 'request_failed'
    );
  }
}
