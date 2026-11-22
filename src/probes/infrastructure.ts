import { lookup, Resolver } from 'node:dns/promises';
import { createConnection, isIP } from 'node:net';
import { connect } from 'node:tls';
import type { FetchCompletion } from '../protocols/completion.js';
import { validateTarget } from '../protocols/transport.js';
import type { AuditInput, AuditOptions, ProbeResult } from '../schema/index.js';
import { result } from './results.js';

type Check = NonNullable<ProbeResult['checks']>[number];
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function bounded<T>(
  signal: AbortSignal,
  operation: () => Promise<T>
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    operation()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', abort));
  });
}

async function dnsRecords(
  hostname: string,
  signal: AbortSignal,
  reserve: () => void
) {
  const resolver = new Resolver({ timeout: 2000, tries: 1 });
  const abort = () => resolver.cancel();
  signal.addEventListener('abort', abort, { once: true });
  try {
    reserve();
    const addresses = await bounded(signal, () =>
      lookup(hostname, { all: true })
    );
    const records: Record<string, unknown> = { addresses };
    if (!isIP(hostname)) {
      for (const [name, resolve] of [
        ['CNAME', () => resolver.resolveCname(hostname)],
        ['NS', () => resolver.resolveNs(hostname)],
      ] as const) {
        reserve();
        try {
          records[name] = await bounded(signal, resolve);
        } catch (error) {
          records[name] = [];
          records[`${name}Error`] = message(error);
        }
      }
    }
    return records;
  } finally {
    resolver.cancel();
    signal.removeEventListener('abort', abort);
  }
}

async function tlsCertificate(
  url: URL,
  signal: AbortSignal,
  policy: AuditOptions['networkPolicy'],
  reserve: () => void
) {
  const { address } = await bounded(signal, () =>
    validateTarget(url.href, policy)
  );
  reserve();
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    // Inspect untrusted certificates without sending HTTP credentials or treating them as valid.
    const socket = connect({
      host: address,
      port: Number(url.port || 443),
      servername: isIP(hostname) ? undefined : hostname,
      rejectUnauthorized: false,
    });
    const abort = () => socket.destroy(new Error(message(signal.reason)));
    signal.addEventListener('abort', abort, { once: true });
    socket.once('secureConnect', () => {
      const cert = socket.getPeerCertificate();
      resolve({
        subject: cert.subject?.CN,
        issuer: cert.issuer?.CN,
        validFrom: cert.valid_from,
        validTo: cert.valid_to,
        subjectAltName: cert.subjectaltname,
        fingerprint256: cert.fingerprint256,
        authorized: socket.authorized,
        authorizationError: socket.authorizationError
          ? String(socket.authorizationError)
          : null,
      });
      socket.destroy();
    });
    socket.once('error', reject);
    socket.once('close', () => signal.removeEventListener('abort', abort));
  });
}

async function queryWhois(
  host: string,
  port: number,
  query: string,
  signal: AbortSignal,
  policy: AuditOptions['networkPolicy'],
  reserve: () => void,
  maxBytes: number
) {
  if (!/^[a-z0-9.-]+$/i.test(host) || !/^[a-z0-9.-]+$/i.test(query))
    throw new Error('Invalid WHOIS host or query');
  const { address } = await bounded(signal, () =>
    validateTarget(`https://${host}`, policy)
  );
  reserve();
  return new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: address, port });
    const abort = () => socket.destroy(new Error(message(signal.reason)));
    signal.addEventListener('abort', abort, { once: true });
    let raw = '';
    let bytes = 0;
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${query}\r\n`));
    socket.on('data', (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > maxBytes) {
        socket.destroy(new Error('WHOIS response byte budget exceeded'));
        return;
      }
      raw += chunk;
    });
    socket.once('end', () => resolve(raw));
    socket.once('error', reject);
    socket.once('close', () => signal.removeEventListener('abort', abort));
  });
}

async function whoisRecord(
  hostname: string,
  signal: AbortSignal,
  options: AuditOptions,
  reserve: () => void
) {
  const custom = options.infrastructure?.whoisServer;
  if (custom && options.networkPolicy !== 'local')
    throw new Error('Custom WHOIS servers require local network policy');
  if (
    custom &&
    (!Number.isInteger(custom.port) || custom.port < 1 || custom.port > 65535)
  )
    throw new Error('Invalid WHOIS port');
  const maxBytes = Math.min(65536, options.limits?.maxResponseBytes ?? 65536);
  const query = (host: string, port: number, name: string) =>
    queryWhois(
      host,
      port,
      name,
      signal,
      options.networkPolicy,
      reserve,
      maxBytes
    );
  let server = custom?.host ?? 'whois.iana.org';
  if (!custom) {
    const bootstrap = await query(server, 43, hostname.split('.').at(-1)!);
    const referral = /^(?:refer|whois):\s*([a-z0-9.-]+)\s*$/im.exec(
      bootstrap
    )?.[1];
    if (!referral)
      throw new Error('No authoritative WHOIS referral was returned');
    server = referral;
  }
  const labels = hostname.split('.');
  let raw = '';
  let domain = hostname;
  for (let i = 0; i < Math.min(3, Math.max(1, labels.length - 1)); i++) {
    domain = labels.slice(i).join('.');
    raw = await query(server, custom?.port ?? 43, domain);
    if (/^\s*(?:domain name|domain|registrar):/im.test(raw)) break;
  }
  const summary = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) =>
      /^(?:domain name|domain|registrar|creation date|updated date|registry expiry date|name server|domain status):/i.test(
        line
      )
    )
    .slice(0, 24)
    .join('\n');
  if (!summary) throw new Error('WHOIS returned no domain registration fields');
  return { server, domain, summary };
}

export async function probeInfrastructure(
  input: AuditInput,
  fetch: FetchCompletion,
  options: AuditOptions,
  reserve: () => void
): Promise<ProbeResult> {
  const started = performance.now();
  const url = new URL(input.target.baseUrl);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const signal = AbortSignal.any([
    AbortSignal.timeout(12000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const checks: Check[] = [];
  const collect = async (
    id: string,
    titleZh: string,
    titleEn: string,
    operation: () => Promise<Record<string, unknown>>
  ) => {
    try {
      checks.push({
        id,
        titleZh,
        titleEn,
        execution: 'completed',
        verdict: 'pass',
        informational: true,
        observations: {
          input: {
            hostname,
            operation: id,
            ...(id === 'tls_certificate'
              ? { port: Number(url.port || 443) }
              : {}),
            ...(id === 'dns_records'
              ? { recordTypes: ['A', 'AAAA', 'CNAME', 'NS'] }
              : {}),
          },
          ...(await operation()),
        },
      });
    } catch (error) {
      checks.push({
        id,
        titleZh,
        titleEn,
        execution: 'error',
        verdict: 'inconclusive',
        observations: {
          input: { hostname, operation: id },
          reason: message(error),
        },
      });
    }
  };
  await collect(
    'endpoint_reachability',
    '端点可达性检查',
    'Endpoint reachability check',
    async () => {
      const response = await fetch(`${url.origin}/`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(4000)]),
      });
      await response.text();
      return {
        status: response.status,
        reachable: true,
        contentType: response.headers.get('content-type'),
      };
    }
  );
  await collect('dns_records', 'DNS 记录', 'DNS records', () =>
    dnsRecords(hostname, signal, reserve)
  );
  if (url.protocol === 'https:')
    await collect(
      'tls_certificate',
      'TLS 证书检查',
      'TLS certificate check',
      () => tlsCertificate(url, signal, options.networkPolicy, reserve)
    );
  else
    checks.push({
      id: 'tls_certificate',
      titleZh: 'TLS 证书检查',
      titleEn: 'TLS certificate check',
      execution: 'unsupported',
      verdict: 'inconclusive',
      observations: {
        input: {
          hostname,
          operation: 'tls_certificate',
          protocol: url.protocol,
        },
        reason: 'The target uses HTTP without TLS',
      },
    });
  if (!isIP(hostname) || options.infrastructure?.whoisServer)
    await collect('whois_lookup', 'WHOIS 查询', 'WHOIS lookup', () =>
      whoisRecord(hostname, signal, options, reserve)
    );
  else
    checks.push({
      id: 'whois_lookup',
      titleZh: 'WHOIS 查询',
      titleEn: 'WHOIS lookup',
      execution: 'unsupported',
      verdict: 'inconclusive',
      observations: {
        input: { hostname, operation: 'whois_lookup' },
        reason: 'Domain WHOIS is unavailable for an IP literal',
      },
    });
  const output = result(
    'infrastructure_recon',
    started,
    {
      hostname,
      checks: checks.map((check) => ({ id: check.id, ...check.observations })),
      scope:
        'Network entry inventory; no model authenticity or domain ownership proof',
    },
    [],
    'completed',
    checks.some((check) => check.verdict === 'inconclusive')
  );
  return { ...output, checks };
}
