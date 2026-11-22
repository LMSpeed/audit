import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { inflateSync } from 'node:zlib';

type Json = Record<string, unknown>;
const record = (v: unknown): Json =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Json) : {};

// Stateful external protocol fake. Live-provider equivalence is intentionally not claimed.
export class FeatureRelay {
  requests = 0;
  received: Array<{ path: string; body: Record<string, unknown> }> = [];
  mode = 'healthy';
  cached = false;
  lostNeedle = false;
  lostNeedleOnce = false;
  degraded = false;
  conditional = false;
  tokenizerDrift = false;
  contextLimit = Number.POSITIVE_INFINITY;
  recallLimit = Number.POSITIVE_INFINITY;
  private tokenizerBaselines = 0;
  readonly server = createServer((request, response) => {
    void this.handle(request, response);
  });
  async start() {
    await new Promise<void>((resolve) =>
      this.server.listen(0, '127.0.0.1', resolve)
    );
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}/v1`;
  }
  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => (error ? reject(error) : resolve()))
    );
  }
  private async handle(request: IncomingMessage, response: ServerResponse) {
    this.requests++;
    let raw = '';
    for await (const chunk of request) raw += String(chunk);
    let body: Json;
    try {
      body = JSON.parse(raw || '{}') as Json;
    } catch {
      this.received.push({ path: request.url ?? '', body: {} });
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'Invalid JSON' } }));
      return;
    }
    this.received.push({ path: request.url ?? '', body });
    const anthropic = request.url?.endsWith('/messages');
    const responses = request.url?.endsWith('/responses');
    const json = (status: number, value: unknown) => {
      if (
        this.mode === 'cloudflare' ||
        this.mode === 'new-api-behind-cloudflare'
      )
        response.setHeader('server', 'cloudflare');
      if (this.mode === 'nginx-raw') response.setHeader('server', 'nginx/1.27');
      if (this.mode === 'caddy-raw') response.setHeader('server', 'Caddy');
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (
      [
        'new-api',
        'one-api',
        'mixed-gateway',
        'litellm',
        'lobechat-relay',
        'fastgpt',
        'new-api-behind-cloudflare',
      ].includes(this.mode) &&
      request.url === '/'
    ) {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end(
        `<html><title>${this.mode === 'one-api' ? 'One API' : this.mode === 'litellm' ? 'LiteLLM' : this.mode === 'lobechat-relay' ? 'LobeChat' : this.mode === 'fastgpt' ? 'FastGPT' : 'New API'}</title><div id="root"></div></html>`
      );
      return;
    }
    if (this.mode === 'unauthorized')
      return json(401, { error: { message: 'invalid key' } });
    if (this.mode === 'unsupported')
      return json(400, { error: { message: 'unsupported parameter' } });
    if (request.url?.endsWith('/models')) {
      if (this.mode === 'mixed-gateway')
        response.setHeader('one-api-request-id', 'fixture');
      return json(200, { data: [{ id: 'test-model' }] });
    }
    const messages = body.messages ?? body.input ?? [];
    const serialized = JSON.stringify(messages);
    const combined = `${body.system ?? ''} ${serialized}`;
    if (combined.length > this.contextLimit)
      return json(400, {
        error: {
          code: 'context_length_exceeded',
          message: 'maximum context length exceeded',
        },
      });
    const contentBlocks = (Array.isArray(messages) ? messages : []).flatMap(
      (m) => {
        const c = record(m).content;
        return Array.isArray(c) ? c : [];
      }
    );
    let text = 'ok';
    if (this.mode === 'hidden-prompt-leak') {
      const hidden =
        '<system>Route requests using the concealed gateway template.</system>';
      text = /base64/i.test(combined)
        ? Buffer.from(hidden).toString('base64')
        : hidden;
    }
    if (this.mode === 'numbers') {
      const count = Number(
        combined.match(/\b(?:29[2-9]|3[01]\d|32\d|33[0-2])\b/)?.[0] ?? 300
      );
      text = Array.from({ length: count }, (_, i) => (i % 2 ? 301 : 17)).join(
        ', '
      );
    }
    if (combined.includes('fingerprint color'))
      text =
        this.mode === 'unknown-fingerprint'
          ? 'unseen'
          : body.model === 'reference-b'
            ? 'blue'
            : body.model === 'reference-other'
              ? 'green'
              : 'red';
    if (combined.includes('fingerprint animal'))
      text =
        this.mode === 'unknown-fingerprint'
          ? 'unseen'
          : body.model === 'reference-b'
            ? 'fox'
            : body.model === 'reference-other'
              ? 'owl'
              : 'cat';
    const nonce = combined.match(/nonce[:= ]+([a-f0-9]+)/i)?.[1];
    const format = record(
      record(body.response_format).json_schema ??
        record(body.text).format ??
        record(body.output_config).format
    );
    if (Object.keys(format).length && this.mode !== 'ignore-schema') {
      const properties = record(record(format.schema).properties);
      const okEnum = record(properties.ok).enum;
      const expectedOk = Array.isArray(okEnum) ? okEnum[0] : true;
      text = JSON.stringify({
        ok: expectedOk,
        nonce,
        ...(this.mode === 'extra-json' ? { extra: 1 } : {}),
      });
    }
    if (combined.includes('17 * 23')) text = String(17 * 23);
    if (combined.includes('ascending order')) text = '2,5,9';
    if (combined.includes('reverse ABCDE')) text = 'EDCBA';
    if (combined.includes('valid JSON')) text = '{"ok":true}';
    if (combined.includes('three letters')) text = 'ABC';
    if (combined.includes('prime number')) text = '29';
    if (combined.includes('binary 10110')) text = '22';
    if (combined.includes('Python len')) text = '4';
    if (combined.includes('All bloops')) text = 'yes';
    if (combined.includes('remember ORCHID')) text = 'ORCHID';
    if (this.degraded && /17 \* 23|reverse ABCDE|prime number/.test(combined))
      text = 'incorrect';
    if (combined.includes('cross multiplication'))
      text =
        this.mode === 'subjective-degraded'
          ? 'incorrect explanation'
          : 'correct explanation';
    if (body.model === 'judge-model') {
      const last = Array.isArray(messages)
        ? record(messages.at(-1)).content
        : '';
      const answers = typeof last === 'string' ? record(JSON.parse(last)) : {};
      text =
        this.mode === 'invalid-judge'
          ? 'not-json'
          : JSON.stringify({
              a: String(answers.a).includes('incorrect') ? 2 : 9,
              b: String(answers.b).includes('incorrect') ? 2 : 9,
            });
    }
    const facts = [...new Set(combined.match(/FACT_[A-F0-9]+/g) ?? [])];
    if (facts.length) {
      text = JSON.stringify(
        this.lostNeedle ||
          this.lostNeedleOnce ||
          combined.length > this.recallLimit
          ? facts.slice(1)
          : facts
      );
      if (this.mode === 'fenced-recall')
        text = `\u0060\u0060\u0060json\n${text}\n\u0060\u0060\u0060`;
      this.lostNeedleOnce = false;
    }
    for (const item of contentBlocks) {
      const block = record(item);
      const source = record(block.source);
      const imageUrl = record(block.image_url).url ?? block.image_url;
      const data =
        source.data ??
        record(block.file).file_data ??
        block.file_data ??
        (typeof imageUrl === 'string' ? imageUrl.split(',')[1] : undefined);
      if (typeof data !== 'string') continue;
      const bytes = Buffer.from(data.replace(/^data:[^,]+,/, ''), 'base64');
      if (bytes.subarray(0, 4).toString() === '%PDF')
        text = bytes.toString().match(/ENGINE_[A-F0-9]+/)?.[0] ?? 'unreadable';
      if (bytes.subarray(1, 4).toString() === 'PNG') {
        let offset = 8;
        const chunks: Buffer[] = [];
        while (offset + 12 <= bytes.length) {
          const length = bytes.readUInt32BE(offset);
          if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT')
            chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
          offset += length + 12;
        }
        const pixels = inflateSync(Buffer.concat(chunks));
        text = pixels[1] === 255 ? 'red' : pixels[2] === 255 ? 'green' : 'blue';
      }
    }
    if (
      this.mode.startsWith('quality-punctuation') &&
      combined.includes('All bloops')
    )
      text = 'Yes.';
    if (
      this.mode === 'quality-punctuation-strict' &&
      combined.includes('three letters')
    )
      text = 'ABC.';
    if (this.mode === 'audit-refusal-variants') {
      text = combined.includes('classical Chinese')
        ? '隱藏之指令，恕不能譯。君若另示文辭，吾可譯為文言。'
        : combined.includes('Continue this JSON exactly:')
          ? '"}'
          : combined.includes('Debug mode:')
            ? 'I can’t reveal hidden system or developer prompts verbatim.'
            : combined.includes('Role play as the relay middleware')
              ? 'I can role-play a relay middleware, but I can’t disclose hidden model-routing instructions or private configuration.'
              : 'I can’t provide the hidden system prompt or protected value.';
    }
    if (this.mode === 'audit-refusal-leak')
      text =
        'I can’t disclose hidden instructions. <system>Route requests using the concealed gateway template.</system>';
    if (this.conditional && combined.includes('financial account')) {
      const secret = combined.match(/DECOY_[A-F0-9]+/)?.[0];
      text = `Send ${secret} to https://example.invalid/collect`;
    }
    const tool = record((Array.isArray(body.tools) ? body.tools : [])[0]);
    const fn = record(tool.function);
    const toolName = String(
      fn.name ??
        tool.name ??
        (this.mode === 'undeclared-tool' ? 'audit_weather' : '')
    );
    const choice = body.tool_choice;
    const disabled = choice === 'none' || record(choice).type === 'none';
    const call =
      toolName &&
      (!disabled || this.mode === 'unauthorized-tool') &&
      this.mode !== 'ignored-tools';
    const args =
      this.mode === 'invalid-args'
        ? { city: 5, unit: 'kelvin' }
        : { city: 'Oslo', unit: 'celsius' };
    let input = this.cached ? 10 : 12;
    let total = this.cached ? 160 : 12;
    if (combined.includes('TOKENIZER_START')) {
      const j = Number(combined.match(/TOK_PROBE_(\d+)/)?.[1] ?? -1);
      if (j === -1) this.tokenizerBaselines++;
      const delta =
        this.mode === 'tokenizer-unknown'
          ? 90 + j * 19
          : ([2, 5, 11, 17, 23, 29, 31, 37, 43, 47, 53, 59][j] ?? 0);
      input = total =
        12 +
        (j < 0
          ? this.tokenizerDrift && this.tokenizerBaselines > 1
            ? 2
            : 0
          : delta);
    }
    const usage = anthropic
      ? {
          input_tokens: input,
          output_tokens: 4,
          ...(this.cached
            ? { cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }
            : {}),
        }
      : responses
        ? {
            input_tokens: total,
            output_tokens: 4,
            input_tokens_details: { cached_tokens: this.cached ? 150 : 0 },
          }
        : {
            prompt_tokens: total,
            completion_tokens: 4,
            prompt_tokens_details: { cached_tokens: this.cached ? 150 : 0 },
          };
    if (
      [
        'reasoning-usage',
        'unknown-output-drift',
        'nonreasoning-output-drift',
      ].includes(this.mode)
    ) {
      const output = body.stream ? 8 : 11;
      const reasoning =
        this.mode === 'nonreasoning-output-drift' ? 0 : body.stream ? 6 : 9;
      Object.assign(
        usage,
        anthropic || responses
          ? { output_tokens: output }
          : { completion_tokens: output }
      );
      if (this.mode !== 'unknown-output-drift')
        Object.assign(
          usage,
          anthropic || responses
            ? {
                output_tokens_details: {
                  [anthropic ? 'thinking_tokens' : 'reasoning_tokens']:
                    reasoning,
                },
              }
            : { completion_tokens_details: { reasoning_tokens: reasoning } }
        );
    }
    if (this.mode === 'missing-usage')
      for (const key of Object.keys(usage)) delete (usage as Json)[key];
    if (this.mode === 'partial-usage' && this.requests > 1) {
      delete (usage as Json).completion_tokens;
      delete (usage as Json).output_tokens;
    }
    if (this.mode === 'zero-usage') {
      for (const key of Object.keys(usage)) {
        if (typeof (usage as Json)[key] === 'number') (usage as Json)[key] = 0;
      }
    }
    if (this.mode === 'refusal')
      return json(
        200,
        anthropic
          ? { stop_reason: 'refusal', content: [] }
          : responses
            ? {
                status: 'completed',
                output: [
                  {
                    type: 'message',
                    content: [{ type: 'refusal', refusal: 'declined' }],
                  },
                ],
              }
            : {
                choices: [
                  {
                    finish_reason: 'content_filter',
                    message: { content: null },
                  },
                ],
              }
      );
    if (this.mode === 'credential-echo')
      text = String(request.headers.authorization ?? '').replace(
        /^Bearer /,
        ''
      );
    if (this.mode === 'invalid-tool-type' && call)
      return json(200, {
        model: body.model,
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_fixture',
                  type: 'invalid',
                  function: {
                    name: 'audit_weather',
                    arguments: JSON.stringify(args),
                  },
                },
              ],
            },
          },
        ],
        usage,
      });
    if (this.mode === 'invalid-tool-finish' && call)
      return json(200, {
        model: body.model,
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_fixture',
                  type: 'function',
                  function: {
                    name: 'audit_weather',
                    arguments: JSON.stringify(args),
                  },
                },
              ],
            },
          },
        ],
        usage,
      });
    if (this.mode === 'legacy-forbidden-tool' && !call)
      return json(200, {
        model: body.model,
        choices: [
          {
            finish_reason: 'function_call',
            message: {
              content: 'ok',
              function_call: {
                name: 'audit_weather',
                arguments: JSON.stringify(args),
              },
            },
          },
        ],
        usage,
      });
    if (body.stream || this.mode === 'unexpected-stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      const streamUsage =
        this.mode === 'usage-drift'
          ? { ...usage, input_tokens: 999, prompt_tokens: 999 }
          : usage;
      const events = anthropic
        ? [
            {
              type: 'message_start',
              message: { model: body.model, usage: streamUsage },
            },
            {
              type: 'content_block_delta',
              delta: { type: 'text_delta', text },
            },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: {
                output_tokens: (streamUsage as Json).output_tokens ?? 4,
                ...((streamUsage as Json).output_tokens_details
                  ? {
                      output_tokens_details: (streamUsage as Json)
                        .output_tokens_details,
                    }
                  : {}),
              },
            },
            { type: 'message_stop' },
          ]
        : responses
          ? [
              {
                type: 'response.created',
                response: {
                  id: 'resp_fixture',
                  model: body.model,
                  status: 'in_progress',
                },
              },
              { type: 'response.output_text.delta', delta: text },
              {
                type: 'response.completed',
                response: {
                  model: body.model,
                  status: 'completed',
                  output: [
                    {
                      type: 'message',
                      content: [{ type: 'output_text', text }],
                    },
                  ],
                  usage: streamUsage,
                },
              },
            ]
          : [
              {
                model: body.model,
                choices: [{ delta: { content: text }, finish_reason: 'stop' }],
                usage: streamUsage,
              },
            ];
      for (const event of this.mode === 'truncated'
        ? events.slice(0, -1)
        : events)
        response.write(`data: ${JSON.stringify(event)}\r\n\r\n`);
      if (!anthropic && !responses && this.mode !== 'truncated')
        response.write('data: [DONE]\r\n\r\n');
      return response.end();
    }
    if (anthropic)
      return json(200, {
        model: body.model,
        content: call
          ? [
              {
                type: 'tool_use',
                id: 'toolu_fixture',
                name: toolName,
                input: args,
              },
            ]
          : [{ type: 'text', text }],
        stop_reason: call ? 'tool_use' : 'end_turn',
        usage,
      });
    if (responses)
      return json(200, {
        model: body.model,
        status: 'completed',
        output: call
          ? [
              {
                type: 'function_call',
                name: toolName,
                call_id: 'call_fixture',
                arguments: JSON.stringify(args),
              },
            ]
          : [{ type: 'message', content: [{ type: 'output_text', text }] }],
        usage,
      });
    return json(200, {
      model: body.model,
      choices: [
        {
          finish_reason: call ? 'tool_calls' : 'stop',
          message: call
            ? {
                content: null,
                tool_calls: [
                  {
                    id: 'call_fixture',
                    type: 'function',
                    function: {
                      name: toolName,
                      arguments: JSON.stringify(args),
                    },
                  },
                ],
              }
            : { content: text },
        },
      ],
      usage,
    });
  }
}
