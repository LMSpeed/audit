import type { TokenizerBank } from '../identity/tokenizer-bank.js';
import type { FingerprintBaseline, FingerprintCollection } from './identity.js';

export type * from './identity.js';
export type AuditProtocol = 'auto' | 'openai' | 'anthropic' | 'responses';
export type AuditProfile = 'connectivity' | 'general' | 'web3' | 'full';
export type AuditTarget = {
  baseUrl: string;
  modelId: string;
  protocol?: AuditProtocol;
};
export type AuditInput = {
  target: AuditTarget;
  apiKey: string;
  profile?: AuditProfile;
  probes?: readonly string[];
  capabilities?: {
    thinking?: boolean;
    contextWindowTokens?: number;
    tokenBaselines?: Record<string, number>;
    tools?: boolean;
    structuredOutput?: boolean;
    vision?: boolean;
    pdf?: boolean;
  };
  generation?: {
    temperature?: number;
    maxOutputTokens?: number;
    reasoningEffort?: 'low' | 'medium' | 'high';
  };
  context?: { sizes: number[]; positions?: number[] };
  reference?: { target: AuditTarget; apiKey: string };
  judge?: { target: AuditTarget; apiKey: string; minimumScore?: number };
  identity?: {
    baseline: FingerprintBaseline;
    claimedModel: string;
    samplesPerPrompt?: number;
  };
  tokenizer?: {
    bank: TokenizerBank;
    maximumProbes?: number;
    maxAgeDays?: number;
  };
  numericFingerprint?: {
    dataDirectory: string;
    detectorSha256: string;
    maximumAgeDays?: number;
  };
  collection?: FingerprintCollection;
};
export type ProbeExecution =
  | 'completed'
  | 'blocked'
  | 'unsupported'
  | 'skipped'
  | 'error';
export type ProbeVerdict = 'pass' | 'finding' | 'inconclusive';
export type Finding = {
  code: string;
  probeId: string;
  severity: 'info' | 'warning' | 'critical';
  confidence: 'weak' | 'moderate' | 'strong';
  evidence: string;
};
export type ProbeResult = {
  id: string;
  execution: ProbeExecution;
  verdict: ProbeVerdict;
  durationMs: number;
  findings: Finding[];
  observations: Record<string, unknown>;
};
export type AuditReport = {
  schemaVersion: '1';
  engineVersion: string;
  rulesetVersion: string;
  target: AuditTarget;
  startedAt: string;
  finishedAt: string;
  probes: ProbeResult[];
  findings: Finding[];
  coverage: {
    requested: string[];
    completed: string[];
    inconclusive: string[];
    blocked: string[];
    skipped: string[];
    unsupported: string[];
  };
  assessment: {
    policyId: string;
    verdict: 'findings' | 'no_findings' | 'inconclusive';
  };
  usage: { requests: number; inputTokensEstimated: number };
};
export type AuditEvent = {
  type: 'probe_started' | 'probe_completed';
  probeId: string;
  result?: ProbeResult;
};
export type AuditOptions = {
  signal?: AbortSignal;
  onEvent?: (event: AuditEvent) => void | Promise<void>;
  networkPolicy?: 'public' | 'local';
  limits?: {
    maxRequests?: number;
    maxInputTokens?: number;
    maxDurationMs?: number;
    maxResponseBytes?: number;
  };
  pacingMs?: number;
};
const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const strings = (value: unknown) =>
  Array.isArray(value) && value.every((entry) => typeof entry === 'string');
export function assertAuditReport(
  value: unknown
): asserts value is AuditReport {
  const report = object(value);
  const target = object(report?.target);
  const coverage = object(report?.coverage);
  const assessment = object(report?.assessment);
  const usage = object(report?.usage);
  const fail = () => {
    throw new Error('Unsupported audit report schema');
  };
  if (
    report?.schemaVersion !== '1' ||
    !target ||
    typeof target.baseUrl !== 'string' ||
    typeof target.modelId !== 'string' ||
    !coverage ||
    !assessment ||
    !usage ||
    !Array.isArray(report.probes) ||
    !Array.isArray(report.findings)
  )
    fail();
  for (const field of [
    'engineVersion',
    'rulesetVersion',
    'startedAt',
    'finishedAt',
  ])
    if (typeof report![field] !== 'string' || !report![field]) fail();
  for (const field of [
    'requested',
    'completed',
    'inconclusive',
    'blocked',
    'skipped',
    'unsupported',
  ])
    if (!strings(coverage![field])) fail();
  if (
    typeof assessment!.policyId !== 'string' ||
    !['findings', 'no_findings', 'inconclusive'].includes(
      String(assessment!.verdict)
    )
  )
    fail();
  for (const field of ['requests', 'inputTokensEstimated'])
    if (
      typeof usage![field] !== 'number' ||
      !Number.isSafeInteger(usage![field]) ||
      Number(usage![field]) < 0
    )
      fail();
  const findingValid = (value: unknown) => {
    const finding = object(value);
    return (
      finding &&
      typeof finding.code === 'string' &&
      typeof finding.probeId === 'string' &&
      typeof finding.evidence === 'string' &&
      ['info', 'warning', 'critical'].includes(String(finding.severity)) &&
      ['weak', 'moderate', 'strong'].includes(String(finding.confidence))
    );
  };
  if (!(report!.findings as unknown[]).every(findingValid)) fail();
  for (const value of report!.probes as unknown[]) {
    const probe = object(value);
    if (
      !probe ||
      typeof probe.id !== 'string' ||
      !['completed', 'blocked', 'unsupported', 'skipped', 'error'].includes(
        String(probe.execution)
      ) ||
      !['pass', 'finding', 'inconclusive'].includes(String(probe.verdict)) ||
      typeof probe.durationMs !== 'number' ||
      !Number.isFinite(probe.durationMs) ||
      probe.durationMs < 0 ||
      !object(probe.observations) ||
      !Array.isArray(probe.findings) ||
      !probe.findings.every(findingValid)
    )
      fail();
  }
}
