import { normalizeRequestedRelayAuditStepIds } from '../catalog.js';
import { createAuditPlan, executeAudit } from '../engine.js';
import type { AuditOptions } from '../schema/index.js';
import type { RelayAuditEngineOptions, RelayAuditInput } from './engine.js';
import { summarizeLegacyAudit } from './engine.js';
import type { RelayAuditEngineOutput } from './types.js';
export async function runLmspeedAudit(
  input: RelayAuditInput,
  options: RelayAuditEngineOptions & AuditOptions = {}
): Promise<RelayAuditEngineOutput> {
  const sharedInput = {
    ...input.detection,
    target: {
      baseUrl: input.baseUrl,
      modelId: input.modelId,
      protocol: input.protocol ?? ('auto' as const),
    },
    apiKey: input.apiKey,
    capabilities: {
      ...input.detection?.capabilities,
      ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
      ...(input.contextWindowTokens !== undefined
        ? { contextWindowTokens: input.contextWindowTokens }
        : {}),
      ...(input.tokenBaselines ? { tokenBaselines: input.tokenBaselines } : {}),
    },
  };
  const steps = options.stepIds
    ? normalizeRequestedRelayAuditStepIds(options.stepIds)
    : normalizeRequestedRelayAuditStepIds(
        createAuditPlan(sharedInput).filter((id) => id !== 'channel_classifier')
      );
  const probes: string[] = steps.filter(
    (id) => id !== 'token_injection' || sharedInput.capabilities.tokenBaselines
  );
  if (steps.includes('infrastructure_fingerprint'))
    probes.push('channel_classifier');
  if (
    steps.includes('token_injection') &&
    !sharedInput.capabilities.tokenBaselines
  )
    await options.onProgress?.({
      event: 'progress',
      stage: 'token_injection',
      status: 'completed',
      severity: 'info',
      messageEn: 'Skipped: calibrated model-specific token baseline required',
      messageZh: '已跳过：需要模型专属的校准 Token 基线',
    });
  const { legacy, report } = await executeAudit(
    {
      ...sharedInput,
      target: {
        baseUrl: input.baseUrl,
        modelId: input.modelId,
        protocol: input.protocol ?? 'auto',
      },
      apiKey: input.apiKey,
      probes: probes.length ? probes : ['token_injection'],
    },
    options,
    options
  );
  const output: RelayAuditEngineOutput = legacy ?? {
    version: 'lmspeed-relay-audit-node-v1',
    targetUrl: input.baseUrl,
    modelId: input.modelId,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    summary: {
      verdict: 'unknown',
      headlineZh: '没有收集到足够证据',
      headlineEn: 'Insufficient evidence',
    },
    signals: {},
    requestedStepIds: [],
    steps: [],
  };
  output.summary = summarizeLegacyAudit(input, output.steps);
  output.startedAt = report.startedAt;
  output.finishedAt = report.finishedAt;
  output.provenance = {
    engineVersion: report.engineVersion,
    rulesetVersion: report.rulesetVersion,
    assessmentPolicy: report.assessment.policyId,
    coverage: {
      requested: report.coverage.requested,
      inconclusive: report.coverage.inconclusive,
    },
  };
  const channel = report.probes.find(
    (probe) => probe.id === 'channel_classifier'
  );
  const framework = output.steps.find(
    (step) => step.id === 'infrastructure_fingerprint'
  );
  if (framework && channel)
    framework.evidence.push({
      labelZh: '上游渠道线索',
      labelEn: 'Upstream channel signal',
      value: JSON.stringify(channel.observations),
      severity: 'info',
    });
  return output;
}
