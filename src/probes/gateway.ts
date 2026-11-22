import type { FetchCompletion } from '../protocols/completion.js';
import type { AuditInput, ProbeResult } from '../schema/index.js';
import { result } from './results.js';

export function classifyFramework(
  headers: Record<string, string>,
  body: string
) {
  const text = `${Object.entries(headers)
    .map(([key, value]) => `${key.toLowerCase()}: ${value}`)
    .join('\n')}\n${body.slice(0, 65536)}`;
  const patterns = [
    [
      'new-api',
      /\bnew api\b|(?:new-api|newapi)(?:-request-id|\/|\b)|github\.com\/Calcium-Ion\/new-api/i,
    ],
    [
      'one-api',
      /\bone api\b|(?:one-api|oneapi)(?:-request-id|\/|\b)|github\.com\/songquanpeng\/one-api/i,
    ],
    ['litellm', /x-litellm-|litellm_proxy|<title[^>]*>[^<]*LiteLLM\b/i],
    [
      'one-hub',
      /one-hub-request-id|<title[^>]*>[^<]*One Hub\b|github\.com\/MartialBE\/one-hub/i,
    ],
    ['lobechat-relay', /\blobechat\b|\blobe-chat\b/i],
    ['fastgpt', /\bfastgpt\b/i],
  ] as const;
  const signals = patterns.flatMap(([framework, pattern]) => {
    const match = pattern.exec(text);
    return match ? [{ framework, evidence: match[0] }] : [];
  });
  const names = [...new Set(signals.map((signal) => signal.framework))];
  const entryStack = [
    ...(Object.keys(headers).some((key) => key.toLowerCase() === 'cf-ray') ||
    /server:.*cloudflare/i.test(text)
      ? ['cloudflare']
      : []),
    ...(/server:.*nginx\//i.test(text) ? ['nginx-raw'] : []),
    ...(/server:.*caddy/i.test(text) ? ['caddy-raw'] : []),
  ];
  return {
    framework:
      names.length === 1
        ? names[0]!
        : names.length
          ? 'ambiguous'
          : (entryStack[0] ?? 'unknown'),
    signals,
    entryStack,
  };
}

export async function probeGateway(
  input: AuditInput,
  fetch: FetchCompletion
): Promise<ProbeResult> {
  const started = performance.now();
  const origin = new URL(input.target.baseUrl).origin;
  const paths = [
    '/',
    `${new URL(input.target.baseUrl).pathname.replace(/\/$/, '')}/models`,
    '/nonexistent-audit-framework-check',
  ];
  const samples: Array<Record<string, unknown>> = [];
  for (const path of [...new Set(paths)]) {
    try {
      const response = await fetch(origin + path);
      const body = await response.text();
      const headers = Object.fromEntries(response.headers.entries());
      samples.push({
        path,
        status: response.status,
        ...classifyFramework(headers, body),
        headers: Object.fromEntries(
          Object.entries(headers)
            .filter(([key]) =>
              ['server', 'x-powered-by', 'cf-ray', 'via', 'x-cache'].includes(
                key
              )
            )
            .map(([key, value]) => [key, value.slice(0, 1024)])
        ),
      });
    } catch (error) {
      samples.push({
        path,
        error: error instanceof Error ? error.message : String(error),
        framework: 'unknown',
        signals: [],
      });
    }
  }
  const frameworks = [
    ...new Set(
      samples
        .map((sample) => String(sample.framework))
        .filter((name) => name !== 'unknown')
    ),
  ];
  const applications = frameworks.filter(
    (name) => !['cloudflare', 'nginx-raw', 'caddy-raw'].includes(name)
  );
  const candidates = applications.length ? applications : frameworks;
  const framework =
    candidates.length === 1
      ? candidates[0]!
      : candidates.length
        ? 'ambiguous'
        : 'unknown';
  return result(
    'infrastructure_fingerprint',
    started,
    {
      framework,
      samples,
      scope:
        'Observed gateway framework signatures; editable headers and page branding do not establish the actual upstream or model identity.',
    },
    [],
    samples.every((sample) => sample.error) ? 'error' : 'completed',
    framework === 'unknown' || framework === 'ambiguous'
  );
}
