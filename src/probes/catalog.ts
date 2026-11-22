import type { RelayAuditStepDefinition } from '../catalog.js';

const entry = <T extends string>(
  id: T,
  titleZh: string,
  titleEn: string,
  descriptionZh: string,
  descriptionEn: string,
  isolation: 'shared' | 'heavy' = 'shared'
) => ({
  id,
  slug: id.replaceAll('_', '-'),
  groupId: [
    'model_fingerprint',
    'numeric_fingerprint',
    'tokenizer_fingerprint',
    'context_recall',
  ].includes(id)
    ? ('model_authenticity' as const)
    : id === 'conditional_injection'
      ? ('prompt_security' as const)
      : ('response_integrity_stability' as const),
  isolation,
  scope: 'model' as const,
  target: 'model' as const,
  automatic: ![
    'image_understanding',
    'pdf_understanding',
    'context_recall',
    'quality_comparison',
    'model_fingerprint',
    'numeric_fingerprint',
    'tokenizer_fingerprint',
  ].includes(id),
  titleZh,
  titleEn,
  descriptionZh,
  descriptionEn,
});
export const CAPABILITY_DEFINITIONS = [
  entry(
    'tool_calling',
    '结构化工具调用',
    'Structured tool calls',
    '检查强制、禁用和未声明工具的返回契约，不执行工具。',
    'Checks forced, disabled and undeclared tool-call contracts without executing tools.'
  ),
  entry(
    'structured_output',
    '严格结构化输出',
    'Strict structured output',
    '检查随机 JSON 约束、字段类型及额外属性。',
    'Checks randomized JSON constraints, field types and extra properties.'
  ),
  entry(
    'image_understanding',
    '图像理解',
    'Image understanding',
    '提交随机图片并核对仅存在于图片中的内容。',
    'Submits generated images and checks content present only in the image.'
  ),
  entry(
    'pdf_understanding',
    'PDF 理解',
    'PDF understanding',
    '提交真实 PDF 并核对文档中的随机标识。',
    'Submits a real PDF and checks its generated identifier.'
  ),
  entry(
    'context_recall',
    '上下文召回复核',
    'Context recall confirmation',
    '使用自然文本和多位置标记复核长上下文召回。',
    'Confirms recall with natural filler and markers at multiple positions.',
    'heavy'
  ),
  entry(
    'stream_consistency',
    '流式与非流式对照',
    'Stream consistency',
    '对照模型标识、协议和报告的 Token 用量。',
    'Compares model identifiers, framing and reported token usage.'
  ),
  entry(
    'quality_canary',
    '基础能力检测',
    'Quality canary',
    '使用可客观判分的数学、逻辑、格式和代码题。',
    'Uses objectively scored math, logic, formatting and code tasks.'
  ),
  entry(
    'quality_comparison',
    '参照质量对比',
    'Reference quality comparison',
    '与可信参照进行配对比较，区分采集失败与答案差异。',
    'Compares paired tasks with a trusted reference, separating acquisition failures from answers.'
  ),
  entry(
    'model_fingerprint',
    '模型分布复核',
    'Model distribution confirmation',
    '按校准基准重复采样；样本不足、过期或不相容时拒判。',
    'Samples against calibrated references, abstaining on insufficient, stale or incompatible evidence.',
    'heavy'
  ),
  entry(
    'numeric_fingerprint',
    '数字指纹初筛',
    'Numeric fingerprint screening',
    '比较数字序列的库内候选，不将排名当作身份认证。',
    'Ranks number-sequence candidates within a reference bank without certifying identity.'
  ),
  entry(
    'tokenizer_fingerprint',
    '分词器旁证',
    'Tokenizer evidence',
    '用差分输入计数识别分词器；基准漂移时拒判。',
    'Uses differential input counts as tokenizer evidence, abstaining on baseline drift.'
  ),
  entry(
    'conditional_injection',
    '条件触发注入',
    'Conditional injection',
    '对照普通和敏感任务，复核诱饵泄漏及外部收集指引。',
    'Compares ordinary and sensitive tasks for decoy disclosure and exfiltration directions.'
  ),
] as const satisfies readonly RelayAuditStepDefinition[];
export type CapabilityProbeId = (typeof CAPABILITY_DEFINITIONS)[number]['id'];
export const CAPABILITY_IDS = CAPABILITY_DEFINITIONS.map((entry) => entry.id);
