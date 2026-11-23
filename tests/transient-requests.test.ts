import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { runAudit } from '../src/index.js';

it.each([
  ['HTTP 524', [524], 'completed', 3],
  ['a dropped connection', ['disconnect'], 'completed', 3],
  ['a model request rejected with HTTP 400', [400], 'blocked', 1],
  ['two gateway timeouts', [524, 524], 'blocked', 2],
] as const)(
  'user receives a bounded structured-output result after %s',
  async (_, failures, execution, attempts) => {
    // Given a real local HTTP endpoint that can reject or drop a request before applying the JSON schema.
    const bodies: string[] = [];
    const server = createServer(async (request, response) => {
      let raw = '';
      for await (const chunk of request) raw += String(chunk);
      bodies.push(raw);
      const status = failures[bodies.length - 1];
      if (status === 'disconnect') {
        response.destroy();
        return;
      }
      response.setHeader('content-type', 'application/json');
      if (status) {
        response
          .writeHead(status)
          .end(
            JSON.stringify({ error: { message: 'Request did not complete' } })
          );
        return;
      }
      const body = JSON.parse(raw);
      const { ok, nonce } = body.response_format.json_schema.schema.properties;
      response.end(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  ok: ok.enum[0],
                  nonce: nonce.enum[0],
                }),
              },
              finish_reason: 'stop',
            },
          ],
        })
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    try {
      const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
      // When the user runs both structured-output samples with a bounded retry budget.
      const report = await runAudit(
        {
          target: { baseUrl, modelId: 'test-model' },
          apiKey: 'test-key',
          probes: ['structured_output'],
        },
        { networkPolicy: 'local', limits: { maxTransientRetries: 4 } }
      );
      // Then retryable failures reuse the original sample and keep both outcomes available in its evidence.
      expect(report.usage.requests).toBe(attempts);
      expect(report.probes[0]?.execution).toBe(execution);
      const firstFailure = failures[0];
      if (firstFailure === 400) return;
      expect(bodies[0]).toBe(bodies[1]);
      expect(report.probes[0]?.observations.requestEvidence).toMatchObject({
        exchanges: [
          {
            retry:
              firstFailure === 'disconnect'
                ? { error: 'socket hang up' }
                : { status: firstFailure },
            response: { status: execution === 'completed' ? 200 : 524 },
          },
          ...(execution === 'completed' ? [{ response: { status: 200 } }] : []),
        ],
      });
      if (execution === 'completed')
        expect(report.probes[0]?.verdict).toBe('pass');
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
);
