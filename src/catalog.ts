import type {
  RelayAuditCheckGroupId,
  RelayAuditEngineStepId,
} from './compat/types.js';
import { CAPABILITY_DEFINITIONS } from './probes/catalog.js';

export type RelayAuditStepIsolation = 'shared' | 'heavy' | 'exclusive';

export type RelayAuditStepScope = 'site' | 'model';

export type RelayAuditStepTarget = 'provider' | 'model';

export type RelayAuditStepDefinition = {
  id: RelayAuditEngineStepId;
  slug: string;
  groupId: RelayAuditCheckGroupId;
  isolation: RelayAuditStepIsolation;
  scope: RelayAuditStepScope;
  target: RelayAuditStepTarget;
  titleZh: string;
  titleEn: string;
  descriptionZh: string;
  descriptionEn: string;
  automatic?: boolean;
};

export const RELAY_AUDIT_STEP_DEFINITIONS = [
  {
    id: 'infrastructure_recon',
    slug: 'infrastructure-recon',
    groupId: 'endpoint_profile',
    isolation: 'shared',
    scope: 'site',
    target: 'provider',
    titleZh: '基础设施侦察',
    titleEn: 'Infrastructure recon',
    descriptionZh:
      '检查 HTTP 入口可达性与响应类型；不执行 DNS、证书或域名所有权审计。',
    descriptionEn:
      'Checks HTTP reachability and content type; does not audit DNS, certificates or domain ownership.',
  },
  {
    id: 'model_list',
    slug: 'model-list',
    groupId: 'endpoint_profile',
    isolation: 'shared',
    scope: 'site',
    target: 'provider',
    titleZh: '模型列表',
    titleEn: 'Model list',
    descriptionZh: '读取端点公开的模型目录，确认请求的模型是否在其中。',
    descriptionEn:
      'Reads the public model catalog and checks whether the requested model is listed.',
  },
  {
    id: 'token_injection',
    slug: 'token-injection',
    groupId: 'prompt_security',
    isolation: 'shared',
    scope: 'model',
    target: 'model',
    titleZh: 'Token 注入',
    titleEn: 'Token injection',
    descriptionZh:
      '将报告的输入计数与当前请求模板的校准值比较，不推断隐藏提示词或账单原因。',
    descriptionEn:
      'Compares reported input counts with current-template calibrations without hidden-prompt or billing attribution.',
  },
  {
    id: 'prompt_extraction',
    slug: 'prompt-extraction',
    groupId: 'prompt_security',
    isolation: 'shared',
    scope: 'model',
    target: 'model',
    titleZh: 'Prompt 提取',
    titleEn: 'Prompt extraction',
    descriptionZh: '使用随机受保护值测量直接泄漏，不提取未知的中转提示词。',
    descriptionEn:
      'Measures direct disclosure of a random protected value; does not recover unknown relay instructions.',
  },
  {
    id: 'instruction_conflict',
    slug: 'instruction-conflict',
    groupId: 'model_authenticity',
    isolation: 'shared',
    scope: 'model',
    target: 'model',
    titleZh: '指令冲突',
    titleEn: 'Instruction conflict',
    descriptionZh: '用随机回应挑战检查系统指令优先级，不判断模型身份。',
    descriptionEn:
      'Tests system instruction priority with a random acknowledgement; does not infer identity.',
  },
  {
    id: 'jailbreak_identity',
    slug: 'jailbreak-identity',
    groupId: 'prompt_security',
    isolation: 'shared',
    scope: 'model',
    target: 'model',
    titleZh: '编码泄漏挑战',
    titleEn: 'Encoded disclosure challenge',
    descriptionZh: '以 JSON 和 Base64 请求尝试泄漏随机受保护值。',
    descriptionEn:
      'Tests JSON and base64 requests for disclosure of a generated protected value.',
  },
  {
    id: 'context_window',
    slug: 'context-window',
    groupId: 'model_authenticity',
    isolation: 'heavy',
    scope: 'model',
    target: 'model',
    titleZh: '上下文窗口',
    titleEn: 'Context window',
    descriptionZh: '在配置的长度与位置检查召回，不测量完整容量边界。',
    descriptionEn:
      'Checks recall at configured sizes and positions; does not measure full capacity.',
  },
  {
    id: 'tool_substitution',
    slug: 'tool-substitution',
    groupId: 'response_integrity_stability',
    isolation: 'shared',
    scope: 'model',
    target: 'model',
    titleZh: '工具调用改写',
    titleEn: 'Tool-call substitution',
    descriptionZh: '检查返回路径是否改写包安装命令。',
    descriptionEn:
      'Checks whether the return path rewrites package-install commands.',
  },
  {
    id: 'error_leakage',
    slug: 'error-leakage',
    groupId: 'response_integrity_stability',
    isolation: 'shared',
    scope: 'model',
    target: 'provider',
    titleZh: '错误响应泄漏',
    titleEn: 'Error response leakage',
    descriptionZh:
      '发送一次无效 JSON 并扫描响应中的敏感配置赋值，不保留赋值内容。',
    descriptionEn:
      'Sends one malformed JSON request and scans for sensitive assignments without retaining their values.',
  },
  {
    id: 'stream_integrity',
    slug: 'stream-integrity',
    groupId: 'model_authenticity',
    isolation: 'shared',
    scope: 'model',
    target: 'model',
    titleZh: '流式完整性',
    titleEn: 'Stream integrity',
    descriptionZh: '检查 SSE 事件结构，以及流式模型名是否和请求一致。',
    descriptionEn:
      'Checks SSE event structure and whether the streamed model name matches the request.',
  },
  {
    id: 'web3_prompt_injection',
    slug: 'web3-prompt-injection',
    groupId: 'prompt_security',
    isolation: 'shared',
    scope: 'model',
    target: 'model',
    titleZh: '钱包恢复策略',
    titleEn: 'Wallet recovery policy',
    descriptionZh: '用结构化回答检查是否建议交出恢复词；仅为行为信号。',
    descriptionEn:
      'Uses a structured response to check recovery-secret sharing advice; a behavioral signal only.',
  },
  {
    id: 'infrastructure_fingerprint',
    slug: 'infrastructure-fingerprint',
    groupId: 'endpoint_profile',
    isolation: 'shared',
    scope: 'site',
    target: 'provider',
    titleZh: '响应头线索',
    titleEn: 'Response header hints',
    descriptionZh: '展示有限的服务响应头线索，不推断真实上游或框架身份。',
    descriptionEn:
      'Reports limited response header hints without inferring the upstream or framework identity.',
  },
  {
    id: 'latency_variance',
    slug: 'latency-variance',
    groupId: 'response_integrity_stability',
    isolation: 'exclusive',
    scope: 'model',
    target: 'model',
    titleZh: '延迟观测',
    titleEn: 'Latency observations',
    descriptionZh: '报告五次请求的延迟统计，不推断路由或模型切换。',
    descriptionEn:
      'Reports latency statistics from five requests without inferring routing or model switching.',
  },
  ...CAPABILITY_DEFINITIONS,
] as const satisfies readonly RelayAuditStepDefinition[];

export type RelayAuditModelStepDefinition = Extract<
  (typeof RELAY_AUDIT_STEP_DEFINITIONS)[number],
  { scope: 'model' }
>;

export const RELAY_AUDIT_MODEL_STEP_DEFINITIONS =
  RELAY_AUDIT_STEP_DEFINITIONS.filter(
    (step): step is RelayAuditModelStepDefinition => step.scope === 'model'
  );

export type RelayAuditProviderTargetStepDefinition = Extract<
  RelayAuditModelStepDefinition,
  { target: 'provider' }
>;

export type RelayAuditModelTargetStepDefinition = Extract<
  RelayAuditModelStepDefinition,
  { target: 'model' }
>;

export const RELAY_AUDIT_PROVIDER_TARGET_STEP_DEFINITIONS =
  RELAY_AUDIT_MODEL_STEP_DEFINITIONS.filter(
    (step): step is RelayAuditProviderTargetStepDefinition =>
      step.target === 'provider'
  );

export const RELAY_AUDIT_MODEL_TARGET_STEP_DEFINITIONS =
  RELAY_AUDIT_MODEL_STEP_DEFINITIONS.filter(
    (step): step is RelayAuditModelTargetStepDefinition =>
      step.target === 'model'
  );

export const RELAY_AUDIT_STEP_IDS = RELAY_AUDIT_STEP_DEFINITIONS.map(
  (step) => step.id
);
export const DEFAULT_RELAY_AUDIT_STEP_IDS = RELAY_AUDIT_STEP_DEFINITIONS.filter(
  (step) => !('automatic' in step) || step.automatic
).map((step) => step.id);

export const RELAY_AUDIT_STEP_SLUGS = RELAY_AUDIT_STEP_DEFINITIONS.map(
  (step) => step.slug
);

export const RELAY_AUDIT_MODEL_STEP_SLUGS =
  RELAY_AUDIT_MODEL_STEP_DEFINITIONS.map((step) => step.slug);

const stepsById = new Map<string, RelayAuditStepDefinition>(
  RELAY_AUDIT_STEP_DEFINITIONS.map((step) => [step.id, step])
);
const stepsBySlug = new Map<string, RelayAuditStepDefinition>(
  RELAY_AUDIT_STEP_DEFINITIONS.map((step) => [step.slug, step])
);

export function getRelayAuditStepById(
  id: string
): RelayAuditStepDefinition | null {
  return stepsById.get(id) ?? null;
}

export function getRelayAuditStepBySlug(
  slug: string
): RelayAuditStepDefinition | null {
  return stepsBySlug.get(slug) ?? null;
}

export function getPublicRelayAuditStepBySlug(
  slug: string
): RelayAuditModelStepDefinition | null {
  return (
    RELAY_AUDIT_MODEL_STEP_DEFINITIONS.find((step) => step.slug === slug) ??
    null
  );
}

export function isPublicRelayAuditStepSlug(value: string): boolean {
  return getPublicRelayAuditStepBySlug(value) !== null;
}

export function isRelayAuditStepId(
  value: string
): value is RelayAuditEngineStepId {
  return stepsById.has(value);
}

export function isRelayAuditStepSlug(value: string): boolean {
  return stepsBySlug.has(value);
}

export function isFullRelayAudit(
  stepIds: readonly string[] | null | undefined
): boolean {
  if (!stepIds || stepIds.length === 0) return true;
  const legacyIds = RELAY_AUDIT_STEP_IDS.filter(
    (id) => !CAPABILITY_DEFINITIONS.some((step) => step.id === id)
  );
  return (
    DEFAULT_RELAY_AUDIT_STEP_IDS.every((id) => stepIds.includes(id)) ||
    (stepIds.length === legacyIds.length &&
      legacyIds.every((id) => stepIds.includes(id)))
  );
}

export function normalizeRequestedRelayAuditStepIds(
  input: unknown
): RelayAuditEngineStepId[] {
  if (input == null) return [...DEFAULT_RELAY_AUDIT_STEP_IDS];
  if (!Array.isArray(input)) {
    throw new Error('Unknown relay audit step id.');
  }
  if (input.length === 0) return [...DEFAULT_RELAY_AUDIT_STEP_IDS];

  const requested = new Set<RelayAuditEngineStepId>();
  for (const value of input) {
    if (typeof value !== 'string' || !isRelayAuditStepId(value)) {
      throw new Error(`Unknown relay audit step: ${String(value)}`);
    }
    requested.add(value);
  }

  return RELAY_AUDIT_STEP_IDS.filter((id) => requested.has(id));
}
