import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { runLmspeedAudit } from '../src/compat/lmspeed.js';
import type { RelayAuditEngineOutput } from '../src/compat/types.js';
import { runAudit } from '../src/index.js';

function deferredEvent() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function startSlowContextEndpoint() {
  const context = deferredEvent();
  const disconnected = deferredEvent();
  // Real HTTP fixture for a model endpoint that never finishes sending a completion.
  const server = createServer(async (request, response) => {
    if (request.url === '/v1/models') {
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
      return;
    }
    let body = '';
    for await (const chunk of request) body += String(chunk);
    if (JSON.parse(body || '{}').stream === true) {
      response.setHeader('content-type', 'text/event-stream');
      response.end(
        'data: {"model":"fixture-model","choices":[{"index":0,"delta":{"content":"Ready"},"finish_reason":null}]}\n\n' +
          'data: {"model":"fixture-model","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: [DONE]\n\n'
      );
      return;
    }
    response.once('close', disconnected.resolve);
    context.resolve();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    contextReceived: context.promise,
    contextDisconnected: disconnected.promise,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

it('user sees independent evidence before a stalled probe times out', async () => {
  // Given a relay whose context request hangs while streaming remains available.
  const relay = await startSlowContextEndpoint();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const streamSaved = deferredEvent();
  const active = new Set<string>();
  const snapshots: RelayAuditEngineOutput[] = [];
  const abort = new AbortController();
  const audit = runLmspeedAudit(
    { baseUrl: relay.baseUrl, modelId: 'fixture-model', apiKey: 'fixture-key' },
    {
      networkPolicy: 'local',
      stepIds: ['context_window', 'stream_integrity'],
      probeConcurrency: 2,
      limits: { maxProbeDurationMs: 100, maxDurationMs: 1_000 },
      signal: abort.signal,
      onProgress: ({ stage, status }) => {
        if (status === 'running') active.add(stage);
        else active.delete(stage);
      },
      onStepComplete: (partial) => {
        snapshots.push(partial);
        if (partial.steps.some((step) => step.id === 'stream_integrity'))
          streamSaved.resolve();
      },
    }
  );
  void audit.catch(() => undefined);
  try {
    // When the user starts both checks and the context check reaches its own deadline.
    await relay.contextReceived;
    expect(active.has('stream_integrity') || snapshots.length > 0).toBe(true);
    await streamSaved.promise;
    expect([...active]).toEqual(['context_window']);
    await vi.advanceTimersByTimeAsync(100);
    // Then progress keeps the successful stream evidence and records the context failure.
    const report = await audit;
    await relay.contextDisconnected;
    expect(active.size).toBe(0);
    expect(
      snapshots.map((partial) => partial.steps.map((step) => step.id))
    ).toEqual([['stream_integrity'], ['context_window', 'stream_integrity']]);
    expect(report.steps).toMatchObject([
      { id: 'context_window', status: 'failed' },
      { id: 'stream_integrity', status: 'completed' },
    ]);
    expect(report.steps[0]?.evidence[0]?.value).toContain(
      'Audit probe timed out'
    );
  } finally {
    abort.abort();
    await audit.catch(() => undefined);
    vi.useRealTimers();
    await relay.close();
  }
});

it.each([
  {
    deadline: 'probe',
    limits: { maxProbeDurationMs: 100, maxDurationMs: 1_000 },
    catalogExecution: 'completed',
    skipped: [],
    requests: 2,
  },
  {
    deadline: 'overall audit',
    limits: { maxDurationMs: 100 },
    catalogExecution: 'skipped',
    skipped: ['model_list'],
    requests: 1,
  },
])(
  'user receives terminal coverage after a $deadline deadline',
  async ({ limits, catalogExecution, skipped, requests }) => {
    // Given a stalled context request ahead of a queued model-list check.
    const relay = await startSlowContextEndpoint();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const abort = new AbortController();
    const audit = runAudit(
      {
        target: { baseUrl: relay.baseUrl, modelId: 'fixture-model' },
        apiKey: 'fixture-key',
        probes: ['context_window', 'model_list'],
      },
      { networkPolicy: 'local', limits, signal: abort.signal }
    );
    void audit.catch(() => undefined);
    try {
      // When the stalled probe reaches the configured deadline.
      await relay.contextReceived;
      await vi.advanceTimersByTimeAsync(100);
      // Then queued work continues when there is time left in the audit budget.
      await expect(audit).resolves.toMatchObject({
        probes: [
          { id: 'context_window', execution: 'error' },
          { id: 'model_list', execution: catalogExecution },
        ],
        coverage: { skipped },
        usage: { requests },
      });
      await relay.contextDisconnected;
    } finally {
      abort.abort();
      await audit.catch(() => undefined);
      vi.useRealTimers();
      await relay.close();
    }
  }
);

it('user sees a stalled request end before the containing probe deadline', async () => {
  // Given a relay that accepts a connection and never finishes its context response.
  const relay = await startSlowContextEndpoint();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const abort = new AbortController();
  const audit = runAudit(
    {
      target: { baseUrl: relay.baseUrl, modelId: 'fixture-model' },
      apiKey: 'fixture-key',
      probes: ['context_window'],
    },
    {
      networkPolicy: 'local',
      limits: { maxRequestDurationMs: 100, maxProbeDurationMs: 300 },
      signal: abort.signal,
    }
  );
  void audit.catch(() => undefined);
  try {
    // When the request reaches its own deadline, before the probe's full allotment.
    await relay.contextReceived;
    await vi.advanceTimersByTimeAsync(300);
    // Then the report records the request timeout and the unanswered context sample.
    await expect(audit).resolves.toMatchObject({
      probes: [
        {
          id: 'context_window',
          verdict: 'inconclusive',
          observations: {
            stopReason: 'timeout',
            requestEvidence: {
              exchanges: [{ error: 'Audit request timed out' }],
            },
          },
        },
      ],
      usage: { requests: 1 },
    });
    await relay.contextDisconnected;
  } finally {
    abort.abort();
    await audit.catch(() => undefined);
    vi.useRealTimers();
    await relay.close();
  }
});

it('user receives request evidence only for samples that were attempted before a probe expired', async () => {
  // Given a gateway whose first request hangs and whose other routes have yet to be checked.
  const relay = await startSlowContextEndpoint();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const abort = new AbortController();
  const audit = runAudit(
    {
      target: { baseUrl: relay.baseUrl, modelId: 'fixture-model' },
      apiKey: 'fixture-key',
      probes: ['infrastructure_fingerprint'],
    },
    {
      networkPolicy: 'local',
      limits: { maxProbeDurationMs: 100 },
      signal: abort.signal,
    }
  );
  void audit.catch(() => undefined);
  try {
    // When the probe's deadline cancels its first request.
    await relay.contextReceived;
    await vi.advanceTimersByTimeAsync(100);
    // Then the report contains one failed exchange and never claims the queued routes were requested.
    await expect(audit).resolves.toMatchObject({
      probes: [
        {
          id: 'infrastructure_fingerprint',
          execution: 'error',
          observations: {
            requestEvidence: {
              exchanges: [{ error: 'Audit probe timed out' }],
            },
          },
        },
      ],
      usage: { requests: 1 },
    });
    await relay.contextDisconnected;
  } finally {
    abort.abort();
    await audit.catch(() => undefined);
    vi.useRealTimers();
    await relay.close();
  }
});

it('user collects several slow responses when each arrives within its own deadline', async () => {
  // Given five HTTP responses that each need 75 ms and a 100 ms request limit.
  const exchanges = Array.from({ length: 5 }, () => ({
    arrived: deferredEvent(),
    release: deferredEvent(),
  }));
  let requestIndex = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.once('end', async () => {
      const exchange = exchanges[requestIndex++];
      exchange?.arrived.resolve();
      await exchange?.release.promise;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          choices: [{ message: { content: 'Ready' }, finish_reason: 'stop' }],
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const abort = new AbortController();
  const audit = runAudit(
    {
      target: { baseUrl, modelId: 'fixture-model' },
      apiKey: 'fixture-key',
      probes: ['latency_variance'],
    },
    {
      networkPolicy: 'local',
      limits: { maxRequestDurationMs: 100, maxProbeDurationMs: 500 },
      signal: abort.signal,
    }
  );
  void audit.catch(() => undefined);
  try {
    // When the user collects five sequential latency measurements.
    for (const { arrived, release } of exchanges) {
      await Promise.race([arrived.promise, audit]);
      await vi.advanceTimersByTimeAsync(75);
      release.resolve();
    }
    // Then all five samples count even though their combined time exceeds one request's limit.
    await expect(audit).resolves.toMatchObject({
      probes: [
        {
          id: 'latency_variance',
          execution: 'completed',
          observations: { count: 5 },
        },
      ],
      usage: { requests: 5 },
    });
  } finally {
    abort.abort();
    for (const { release } of exchanges) release.resolve();
    await audit.catch(() => undefined);
    vi.useRealTimers();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
