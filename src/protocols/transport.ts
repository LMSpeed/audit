import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { checkServerIdentity } from 'node:tls';
import type { AuditOptions } from '../schema/index.js';
import { createTokenUsageCounter } from './token-usage.js';

export function isPublicAddress(address: string) {
  const ip = address.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(ip) === 4) {
    const [a = 0, b = 0, c = 0] = ip.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)))) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 198 && (b === 18 || b === 19))
    );
  }
  return (
    isIP(ip) === 6 &&
    /^[23][0-9a-f]{3}:/.test(ip) &&
    !ip.startsWith('2001:db8:') &&
    !ip.startsWith('2002:')
  );
}
export async function validateTarget(
  value: string,
  policy: 'public' | 'local' = 'public'
) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash)
    throw new Error(
      'Target URL must not contain credentials, query or fragment'
    );
  if (policy === 'public' && url.protocol !== 'https:')
    throw new Error('Hosted audit requires HTTPS');
  if (!['http:', 'https:'].includes(url.protocol))
    throw new Error('Unsupported target URL protocol');
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (
    !addresses.length ||
    (policy === 'public' &&
      addresses.some((entry) => !isPublicAddress(entry.address)))
  )
    throw new Error('Audit target resolves to a private or reserved address');
  return { url, address: addresses[0]!.address };
}
export function createAuditTransport(options: AuditOptions) {
  const usage = { requests: 0, inputTokensEstimated: 0 };
  const tokens = createTokenUsageCounter();
  const maxRequests = options.limits?.maxRequests ?? 200;
  const maxInputTokens = options.limits?.maxInputTokens ?? 2_000_000;
  const maxResponseBytes = options.limits?.maxResponseBytes ?? 4_000_000;
  const maxDuration = options.limits?.maxDurationMs ?? 600_000;
  for (const value of [
    maxRequests,
    maxInputTokens,
    maxResponseBytes,
    maxDuration,
  ])
    if (!Number.isSafeInteger(value) || value <= 0)
      throw new Error('Audit limits must be positive safe integers');
  const controller = new AbortController();
  const deadline = setTimeout(
    () => controller.abort(new Error('Audit duration budget exceeded')),
    maxDuration
  );
  deadline.unref();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const reserveRequest = () => {
    signal.throwIfAborted();
    if (usage.requests >= maxRequests)
      throw new Error('Audit request budget exceeded');
    usage.requests++;
  };
  return {
    usage,
    tokenUsage: () => tokens.snapshot(),
    signal,
    reserveRequest,
    close: () => clearTimeout(deadline),
    fetch: async (
      input: string | URL,
      init: RequestInit = {}
    ): Promise<Response> => {
      signal.throwIfAborted();
      const body = typeof init.body === 'string' ? init.body : '';
      const estimated = Math.ceil(body.length / 4);
      if (
        usage.requests >= maxRequests ||
        usage.inputTokensEstimated + estimated > maxInputTokens
      )
        throw new Error('Audit request or input token budget exceeded');
      const { url, address } = await validateTarget(
        String(input),
        options.networkPolicy
      );
      signal.throwIfAborted();
      if (
        usage.requests >= maxRequests ||
        usage.inputTokensEstimated + estimated > maxInputTokens
      )
        throw new Error('Audit request or input token budget exceeded');
      usage.requests++;
      usage.inputTokensEstimated += estimated;
      const recordTokens = tokens.begin(url, init.method ?? 'GET');
      return new Promise<Response>((resolve, reject) => {
        const request = (
          url.protocol === 'https:' ? httpsRequest : httpRequest
        )(
          {
            hostname: address,
            port: url.port || undefined,
            method: init.method ?? 'GET',
            path: url.pathname + url.search,
            headers: {
              ...Object.fromEntries(new Headers(init.headers).entries()),
              host: url.host,
            },
            servername: url.hostname,
            checkServerIdentity: (_host, cert) =>
              checkServerIdentity(url.hostname, cert),
            signal: init.signal
              ? AbortSignal.any([signal, init.signal])
              : signal,
          },
          (response) => {
            if (
              (response.statusCode ?? 0) >= 300 &&
              (response.statusCode ?? 0) < 400
            ) {
              response.resume();
              reject(
                new Error('Audit redirects are disabled to protect credentials')
              );
              return;
            }
            const chunks: Buffer[] = [];
            let bytes = 0;
            response.on('data', (chunk: Buffer) => {
              bytes += chunk.length;
              if (bytes > maxResponseBytes) {
                request.destroy(
                  new Error('Audit response byte budget exceeded')
                );
                return;
              }
              chunks.push(chunk);
            });
            response.on('error', reject);
            response.on('aborted', () =>
              reject(new Error('Upstream response was aborted'))
            );
            response.on('end', () => {
              const headers = new Headers();
              for (const [name, value] of Object.entries(response.headers))
                if (value !== undefined)
                  headers.set(
                    name,
                    Array.isArray(value) ? value.join(', ') : value
                  );
              const status = response.statusCode ?? 502;
              const body = Buffer.concat(chunks);
              recordTokens(
                body.toString('utf8'),
                headers.get('content-type') ?? '',
                status
              );
              resolve(
                new Response(
                  [204, 205, 304].includes(status)
                    ? null
                    : new Uint8Array(body),
                  { status, headers }
                )
              );
            });
          }
        );
        request.on('error', reject);
        request.end(body || undefined);
      });
    },
  };
}
