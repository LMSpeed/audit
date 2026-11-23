import { createHash } from 'node:crypto';
import type { ProbeResult } from '../schema/index.js';
import {
  type FetchCompletion,
  fromEnvelope,
  parseCompletionStream,
} from './completion.js';

const sensitive =
  /^(?:authorization|cookie|set-cookie|x-api-key|api[_-]?key|access[_-]?token|password|client[_-]?secret|secret[_-]?key)$/i;
const safeHeaders = new Set([
  'content-type',
  'server',
  'via',
  'x-powered-by',
  'cf-ray',
  'x-request-id',
]);

const completionPath = /\/(?:chat\/completions|messages|responses)(?:\?|$)/;
const transientStatuses = new Set([502, 503, 504, 520, 521, 522, 523, 524]);
const transientConnectionError =
  /^(?:socket hang up|client network socket disconnected before secure TLS connection was established|upstream response was aborted|read ECONNRESET|write EPIPE)$/i;

export function isTransientConnectionError(error: string) {
  return transientConnectionError.test(error);
}

function excerpt(value: string) {
  return {
    truncated: true,
    characters: value.length,
    sha256: createHash('sha256').update(value).digest('hex'),
    head: value.slice(0, 1024),
    middle: value.slice(
      Math.floor(value.length / 2) - 512,
      Math.floor(value.length / 2) + 512
    ),
    tail: value.slice(-1024),
  };
}

function snapshot(
  value: unknown,
  scrub: (text: string) => string,
  depth = 0
): unknown {
  if (typeof value === 'string') {
    const safe = scrub(value);
    return safe.length > 8192 ? excerpt(safe) : safe;
  }
  if (depth >= 12) return excerpt(scrub(JSON.stringify(value) ?? ''));
  if (Array.isArray(value)) {
    const entries = value
      .slice(0, 100)
      .map((item) => snapshot(item, scrub, depth + 1));
    return value.length > 100
      ? { truncated: true, items: value.length, retained: entries }
      : entries;
  }
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sensitive.test(key) ? '[redacted]' : snapshot(entry, scrub, depth + 1),
      ])
    );
  return value;
}

function boundedSnapshot(value: unknown, scrub: (text: string) => string) {
  const saved = snapshot(value, scrub);
  const serialized = JSON.stringify(saved) ?? '';
  return serialized.length > 32768 ? excerpt(serialized) : saved;
}

function parse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function safeUrl(raw: string, scrub: (text: string) => string) {
  const url = new URL(raw);
  url.username = '';
  url.password = '';
  for (const key of url.searchParams.keys())
    if (sensitive.test(key) || /token|signature|credential/i.test(key))
      url.searchParams.set(key, '[redacted]');
  return scrub(url.href);
}

export function createProbeEvidence(
  fetch: FetchCompletion,
  scrub: (text: string) => string,
  signal?: AbortSignal,
  reserveRetry?: () => boolean
) {
  const exchanges: Array<Record<string, unknown>> = [];
  let omittedExchanges = 0;
  const recordedFetch: FetchCompletion = async (url, init) => {
    signal?.throwIfAborted();
    if (exchanges.length >= 64) {
      omittedExchanges++;
      return fetch(url, init);
    }
    const exchange: Record<string, unknown> = {
      request: {
        method: init?.method ?? 'GET',
        url: safeUrl(String(url), scrub),
        body:
          typeof init?.body === 'string'
            ? boundedSnapshot(parse(init.body), scrub)
            : null,
      },
    };
    exchanges.push(exchange);
    const started = performance.now();
    const isCompletion = completionPath.test(String(url));
    const canRetry = () =>
      !signal?.aborted &&
      !init?.signal?.aborted &&
      isCompletion &&
      init?.method === 'POST' &&
      reserveRetry?.() === true;
    const rememberRetry = (failure: { status: number } | { error: string }) => {
      exchange.retry = { ...failure, durationMs: performance.now() - started };
    };
    try {
      let response: Response;
      try {
        response = await fetch(url, init);
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !isTransientConnectionError(error.message) ||
          !canRetry()
        )
          throw error;
        rememberRetry({ error: scrub(error.message) });
        response = await fetch(url, init);
      }
      if (
        !exchange.retry &&
        transientStatuses.has(response.status) &&
        canRetry()
      ) {
        rememberRetry({ status: response.status });
        await response.body?.cancel();
        response = await fetch(url, init);
      }
      const raw = await response.clone().text();
      const contentType = response.headers.get('content-type');
      const protocol = /\/messages(?:\?|$)/.test(String(url))
        ? 'anthropic'
        : /\/responses(?:\?|$)/.test(String(url))
          ? 'responses'
          : 'openai';
      const stream =
        contentType?.includes('text/event-stream') ||
        /^(?:\s|:[^\n]*\n)*(?:event:|data:)/.test(raw.slice(0, 2048));
      exchange.response = {
        status: response.status,
        contentType,
        headers: Object.fromEntries(
          [...response.headers].filter(([key]) => safeHeaders.has(key))
        ),
        body: boundedSnapshot(parse(raw), scrub),
        ...(response.ok && isCompletion
          ? {
              completion: boundedSnapshot(
                stream
                  ? parseCompletionStream(raw, protocol, response.status)
                  : fromEnvelope(parse(raw), protocol, response.status),
                scrub
              ),
            }
          : {}),
      };
      return response;
    } catch (error) {
      exchange.error = scrub(
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    } finally {
      exchange.durationMs = performance.now() - started;
    }
  };
  const evidence = (items = exchanges) => ({
    version: 1,
    exchanges: items,
    omittedExchanges,
  });
  return {
    fetch: recordedFetch,
    attach(probe: ProbeResult): ProbeResult {
      return {
        ...probe,
        observations: { ...probe.observations, requestEvidence: evidence() },
        ...(probe.checks
          ? {
              checks: probe.checks.map((check, index) => ({
                ...check,
                observations: {
                  ...check.observations,
                  ...(['prompt_extraction', 'jailbreak_identity'].includes(
                    probe.id
                  )
                    ? {
                        requestEvidence: evidence(
                          exchanges.slice(index, index + 1)
                        ),
                      }
                    : check.id === 'endpoint_reachability'
                      ? { requestEvidence: evidence() }
                      : {}),
                },
              })),
            }
          : {}),
      };
    },
  };
}
