import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { array, object } from '../src/protocols/completion.js';

export class IndependentRelay {
  mode = 'healthy';
  instructionPrefix = '';
  instructionSuffix = '';
  requests = 0;
  model = 'audit-model';
  readonly server = createServer(async (req, res) => {
    this.requests++;
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (this.mode === 'auth')
      return json(401, { error: { message: 'invalid key' } });
    if (req.url?.endsWith('/models'))
      return json(200, { data: [{ id: this.model }] });
    let body: Record<string, unknown>;
    try {
      body = object(JSON.parse(raw));
    } catch {
      return json(400, {
        error: {
          message:
            this.mode === 'leaky-error'
              ? 'DATABASE_URL=postgres://admin:password@db.internal/prod'
              : 'Invalid request',
        },
      });
    }
    const protocol = req.url?.endsWith('/messages')
      ? 'anthropic'
      : req.url?.endsWith('/responses')
        ? 'responses'
        : 'openai';
    const messages = array(body.messages ?? body.input).map(object);
    const system = String(
      body.system ?? messages.find((m) => m.role === 'system')?.content ?? ''
    );
    const user = String(messages.find((m) => m.role === 'user')?.content ?? '');
    let text = 'ready';
    const literal = system.match(
      /^Expected output \(JSON string\): (".*")$/m
    )?.[1];
    const required = literal
      ? String(JSON.parse(literal))
      : system.match(
          this.mode === 'literal-boundary'
            ? /Return exactly (\S+)/
            : /Return exactly ([A-Z0-9_]+)\./
        )?.[1];
    if (required)
      text =
        this.mode === 'ignore-system'
          ? '42'
          : this.mode === 'format-instruction'
            ? `${this.instructionPrefix}${required}${this.instructionSuffix}`
            : required;
    if (user.startsWith('Copy the following literal'))
      text = user.split('\n').at(-1) ?? '';
    if (system.includes('PRIVATE_')) {
      const secret = system.match(/PRIVATE_[a-f0-9]+/)?.[0] ?? '';
      text =
        this.mode === 'leak'
          ? `Refused. ${secret}`
          : 'I cannot disclose that value.';
    }
    if (user.includes('wallet recovery'))
      text = JSON.stringify({
        action: this.mode === 'unsafe-wallet' ? 'share' : 'reject',
      });
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const event = (v: unknown) => res.write(`data: ${JSON.stringify(v)}\n\n`);
      if (protocol === 'anthropic') {
        event({
          type: 'message_start',
          message: {
            model: this.model,
            usage: { input_tokens: 8, output_tokens: 0 },
          },
        });
        event({
          type: 'content_block_delta',
          delta: { type: 'text_delta', text },
        });
        if (this.mode !== 'truncated') event({ type: 'message_stop' });
      } else if (protocol === 'responses') {
        event({ type: 'response.created', response: { model: this.model } });
        if (this.mode !== 'truncated')
          event({
            type: 'response.completed',
            response: {
              model: this.model,
              status: 'completed',
              output: [
                { type: 'message', content: [{ type: 'output_text', text }] },
              ],
            },
          });
      } else {
        event({
          model: this.model,
          choices: [{ delta: { content: text }, finish_reason: 'stop' }],
        });
        if (this.mode !== 'truncated') res.write('data: [DONE]\n\n');
      }
      return res.end();
    }
    json(
      200,
      protocol === 'anthropic'
        ? {
            model: this.model,
            content: [{ type: 'text', text }],
            usage: { input_tokens: 8, output_tokens: 2 },
          }
        : protocol === 'responses'
          ? {
              model: this.model,
              status: 'completed',
              output: [
                { type: 'message', content: [{ type: 'output_text', text }] },
              ],
              usage: { input_tokens: 8, output_tokens: 2 },
            }
          : {
              model: this.model,
              choices: [{ message: { content: text } }],
              usage: { prompt_tokens: 8, completion_tokens: 2 },
            }
    );
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
      this.server.close((err) => (err ? reject(err) : resolve()))
    );
  }
}
