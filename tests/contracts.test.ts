import { describe, expect, it } from 'vitest';
import { runLmspeedAudit } from '../src/compat/lmspeed.js';
import { createAuditPlan, runAudit } from '../src/index.js';
import { classifyChannel } from '../src/probes/channel.js';
import {
  classifyCommandEcho,
  normalizeCommandEcho,
} from '../src/probes/classifiers.js';
import { modelLooksCompatible } from '../src/protocols/model-family.js';
import {
  analyzeRelayAuditSseText,
  parseSseData,
} from '../src/protocols/sse.js';
import { renderReport } from '../src/reporters/index.js';
import { assertAuditReport } from '../src/schema/index.js';
import { IndependentRelay } from './independent-relay.js';

// Protocol boundary cases cannot be reliably requested from a live model.
describe('user receives explicit protocol boundary evidence', () => {
  it.each(['\n', '\r', '\r\n'])(
    'user can read SSE comments and multi-line data with delimiter %j',
    (separator) => {
      // Given a standard event stream with a BOM, comment, id and multi-line data.
      const text = [
        '\uFEFF: comment',
        'id: 7',
        'data: first',
        'data:second',
        '',
        'data: unfinished',
      ].join(separator);
      // When the event data is parsed.
      const data = parseSseData(text);
      // Then only the dispatched event is retained, preserving payload whitespace.
      expect(data).toEqual(['first\nsecond']);
    }
  );
  it.each([
    ['malformed', 'data: {oops}\n\n'],
    ['array', 'data: []\n\n'],
    [
      'model change',
      'data: {"model":"another","choices":[]}\n\ndata: [DONE]\n\n',
    ],
    ['after terminal', 'data: [DONE]\n\ndata: {"model":"requested"}\n\n'],
    [
      'duplicate terminal',
      'data: {"model":"requested"}\n\ndata: [DONE]\n\ndata: [DONE]\n\n',
    ],
    [
      'error event',
      'data: {"model":"requested","error":{"code":"failed"}}\n\ndata: [DONE]\n\n',
    ],
    [
      'usage decrease',
      'data: {"model":"requested","usage":{"prompt_tokens":8,"completion_tokens":5}}\n\ndata: {"model":"requested","usage":{"prompt_tokens":9,"completion_tokens":2}}\n\ndata: [DONE]\n\n',
    ],
  ])('user receives a finding for %s', (_name, text) => {
    // Given a malformed or contradictory protocol stream.
    // When the stream is inspected against the requested model.
    const analysis = analyzeRelayAuditSseText({
      text,
      protocol: 'openai',
      expectedModelId: 'requested',
    });
    // Then the corruption cannot be reported as safe.
    expect(analysis.severity).toBe('critical');
  });
  it('user accepts a future Messages event while preserving required lifecycle checks', () => {
    // Given a forward-compatible event inside a complete Messages stream.
    const text = [
      { type: 'message_start', message: { model: 'requested' } },
      { type: 'future_event' },
      { type: 'message_stop' },
    ]
      .map((v) => `data: ${JSON.stringify(v)}\n\n`)
      .join('');
    // When the published forward-compatible stream contract is checked.
    const result = analyzeRelayAuditSseText({
      text,
      protocol: 'anthropic',
      expectedModelId: 'requested',
    });
    // Then an unknown event alone does not mark the stream corrupt.
    expect(result.severity).toBe('safe');
  });
  it.each(['data: {"type":"ping"}\n\n', ': heartbeat\n\n'])(
    'user receives no model verdict for heartbeat-only traffic %j',
    (text) => {
      // Given no substantive model data.
      // When the connection is analyzed.
      const result = analyzeRelayAuditSseText({
        text,
        protocol: 'anthropic',
        expectedModelId: 'requested',
      });
      // Then absent evidence is inconclusive.
      expect(result.severity).toBe('warning');
      expect(result.modelCompatible).toBeNull();
    }
  );
  it('user sees an empty thinking signature as a malformed payload without cryptographic claims', () => {
    // Given an empty signature delta between start and stop.
    const text = [
      { type: 'message_start', message: { model: 'requested' } },
      {
        type: 'content_block_delta',
        delta: { type: 'signature_delta', signature: '' },
      },
      { type: 'message_stop' },
    ]
      .map((v) => `data: ${JSON.stringify(v)}\n\n`)
      .join('');
    // When its presence contract is checked.
    const result = analyzeRelayAuditSseText({
      text,
      protocol: 'anthropic',
      expectedModelId: 'requested',
    });
    // Then it reports the empty payload.
    expect(result.signatureValid).toBe(false);
    expect(result.severity).toBe('critical');
  });
  it.each([
    [{ 'CF-AIG-Cache-Status': 'MISS' }, 'cloudflare-ai-gateway'],
    [{ 'x-amzn-bedrock-invocation-latency': '5' }, 'aws-bedrock'],
    [{ 'anthropic-ratelimit-requests-limit': '100' }, 'anthropic-api'],
    [
      { 'cf-aig-request-id': 'x', 'x-amzn-bedrock-invocation-latency': '5' },
      'ambiguous',
    ],
    [{ server: 'cloudflare', 'x-goog-request-id': 'x' }, 'unknown'],
  ] as const)('user receives header scope %s as %s', (headers, channel) => {
    // Given named header evidence, possibly conflicting or generic.
    // When a serving hint is requested.
    const result = classifyChannel(headers, '{"id":"gen-pretend"}');
    // Then body ID formats never override the explicit header boundary.
    expect(result.channel).toBe(channel);
    expect(result.confidence).toBe(
      channel === 'unknown' || channel === 'ambiguous' ? 0 : 0.5
    );
  });
  it('user does not treat changed package case or unrelated commands as the requested literal', () => {
    // Given a case-sensitive package name and a response containing extra commands.
    const expected = 'pnpm add @org/ExactName';
    // When the text comparison is performed.
    const received = normalizeCommandEcho(
      `pnpm add @org/exactname\nrm -rf tmp`,
      expected
    );
    // Then a changed literal cannot pass through normalization.
    expect(classifyCommandEcho(expected, received)).toBe('substituted');
    expect(modelLooksCompatible('model-20260101', 'model')).toBe(false);
  });
});

describe('user receives portable reports and website progress', () => {
  it('user can serialize and render the independent report and reject malformed schema input', async () => {
    // Given a real local endpoint and the public SDK.
    const relay = new IndependentRelay();
    const baseUrl = await relay.start();
    try {
      // When a completed run is encoded and reloaded.
      const report = await runAudit(
        {
          target: { baseUrl, modelId: relay.model },
          apiKey: 'contract-key',
          probes: ['model_list'],
        },
        { networkPolicy: 'local' }
      );
      const parsed: unknown = JSON.parse(JSON.stringify(report));
      assertAuditReport(parsed);
      // Then export formats retain measured coverage and conform to Schema v1.
      expect(renderReport(parsed, 'markdown')).toContain(
        'model_list: completed / pass'
      );
      expect(renderReport(parsed, 'text')).toContain('1/1 completed');
      expect(JSON.parse(renderReport(parsed)).assessment.verdict).toBe(
        'no_findings'
      );
      expect(() =>
        assertAuditReport({
          ...parsed,
          usage: { requests: -1, inputTokensEstimated: 0 },
        })
      ).toThrow('schema');
      expect(() =>
        assertAuditReport({ ...parsed, probes: [{ id: 'bad' }] })
      ).toThrow('schema');
      expect(() => assertAuditReport({ ...parsed, findings: [{}] })).toThrow(
        'schema'
      );
    } finally {
      await relay.close();
    }
  });
  it.each(['healthy', 'auth', 'ignore-system'])(
    'user receives adapter evidence and progress for %s',
    async (mode) => {
      // Given an endpoint whose model contract is acquired, blocked or violated.
      const relay = new IndependentRelay();
      relay.mode = mode;
      const baseUrl = await relay.start();
      const progress: string[] = [];
      const persisted: string[] = [];
      try {
        // When the website adapter runs two selected checks.
        const output = await runLmspeedAudit(
          { baseUrl, modelId: relay.model, apiKey: 'contract-key' },
          {
            networkPolicy: 'local',
            stepIds: ['model_list', 'instruction_conflict'],
            onProgress: (event) => {
              progress.push(`${event.stage}:${event.status}`);
            },
            onStepComplete: (partial) => {
              persisted.push(JSON.stringify(partial));
            },
          }
        );
        // Then progress, coverage and the final outcome agree.
        expect(progress).toEqual([
          'model_list:running',
          'model_list:completed',
          'instruction_conflict:running',
          'instruction_conflict:completed',
        ]);
        expect(persisted).toHaveLength(2);
        const partial = JSON.parse(persisted[0]!) as typeof output;
        expect(partial.provenance?.rulesetVersion).toContain('independent');
        expect(persisted.join('')).not.toContain('contract-key');
        expect(output.summary.verdict).toBe(
          mode === 'auth'
            ? 'unknown'
            : mode === 'ignore-system'
              ? 'caution'
              : 'trusted'
        );
        expect(output.provenance?.rulesetVersion).toContain('independent');
        expect(output.provenance?.upstreamCommit).toBeUndefined();
      } finally {
        await relay.close();
      }
    }
  );
  it('user cannot submit an unknown probe or reuse an old token calibration', () => {
    // Given invalid selection and obsolete template names.
    const input = {
      target: { baseUrl: 'https://example.com', modelId: 'm' },
      apiKey: 'contract-key',
    };
    // When a plan is constructed without network requests.
    // Then incompatible settings are rejected at the input boundary.
    expect(() =>
      createAuditPlan({ ...input, probes: ['no-such-probe'] })
    ).toThrow('probe');
    expect(() =>
      createAuditPlan({
        ...input,
        capabilities: { tokenBaselines: { short_prompt_baseline: 12 } },
      })
    ).toThrow('calibrated baselines');
    expect(() =>
      createAuditPlan({ ...input, profile: 'invalid' as 'full' })
    ).toThrow('profile');
  });
});
