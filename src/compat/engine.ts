import type { AuditInput } from '../schema/index.js';
import type {
  RelayAuditEngineOutput,
  RelayAuditEngineStep,
  RelayAuditEngineStepId,
  RelayAuditProgressEvent,
} from './types.js';
export type RelayAuditInput = {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  protocol?: AuditInput['target']['protocol'];
  thinking?: boolean;
  contextWindowTokens?: number;
  tokenBaselines?: Record<string, number>;
  detection?: Omit<
    AuditInput,
    'target' | 'apiKey' | 'profile' | 'probes' | 'collection'
  >;
};
export type RelayAuditEngineOptions = {
  stepIds?: readonly RelayAuditEngineStepId[];
  onProgress?: (event: RelayAuditProgressEvent) => void | Promise<void>;
  onStepComplete?: (output: RelayAuditEngineOutput) => void | Promise<void>;
};
export function summarizeLegacyAudit(
  _input: RelayAuditInput,
  steps: RelayAuditEngineStep[]
): RelayAuditEngineOutput['summary'] {
  const modelSteps = steps.filter(
    (step) =>
      ![
        'model_list',
        'infrastructure_recon',
        'infrastructure_fingerprint',
      ].includes(step.id)
  );
  const evidence = modelSteps.some((step) =>
    step.tests.some(
      (test) =>
        test.status === 'passed' ||
        test.status === 'failed' ||
        test.status === 'warning'
    )
  );
  const acquired = steps.some((step) => step.status === 'completed');
  const blocked = !evidence && modelSteps.length > 0;
  const failure = modelSteps.find(
    (step) => step.status === 'blocked' || step.status === 'failed'
  );
  const text = JSON.stringify(failure?.evidence ?? []);
  const reason = /401|403/.test(text)
    ? 'auth_failed'
    : /429/.test(text)
      ? 'rate_limited'
      : /404/.test(text)
        ? 'model_unavailable'
        : /400|422/.test(text)
          ? 'request_rejected'
          : /50[0-9]/.test(text)
            ? 'upstream_error'
            : 'request_failed';
  const finding = steps.some((step) =>
    step.tests.some(
      (test) =>
        ['critical', 'warning'].includes(test.severity) &&
        test.status === 'failed'
    )
  );
  return {
    verdict: finding
      ? 'caution'
      : evidence || (acquired && !blocked)
        ? 'trusted'
        : 'unknown',
    headlineZh: blocked
      ? '未获取足够的模型证据'
      : finding
        ? '检测发现契约差异'
        : '已完成所选检测；结果仅描述本次观测',
    headlineEn: blocked
      ? 'Insufficient model evidence'
      : finding
        ? 'Observed contract differences'
        : 'Selected checks finished; results describe this run only',
    ...(blocked
      ? { completionStatus: 'blocked', completionReason: reason }
      : {}),
  };
}
