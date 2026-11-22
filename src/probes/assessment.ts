export type AuditAssessmentReason =
  | 'accessDenied'
  | 'rateLimited'
  | 'upstreamUnavailable'
  | 'capabilityUnsupported'
  | 'budgetExhausted'
  | 'requestTimedOut'
  | 'referenceRequired'
  | 'modelReferenceMissing'
  | 'referenceExpired'
  | 'unparseableResponse'
  | 'incompleteResponse'
  | 'probeRefused'
  | 'unexpectedStream'
  | 'missingUsage'
  | 'requestFailed'
  | 'ambiguousDisclosure';

export function getAuditInconclusiveReason(
  observations: Record<string, unknown>
): AuditAssessmentReason | null {
  const reason = observations.reason;
  if (observations.status === 401 || observations.status === 403)
    return 'accessDenied';
  if (observations.status === 429) return 'rateLimited';
  if (typeof observations.status === 'number' && observations.status >= 500)
    return 'upstreamUnavailable';
  if (observations.outcome === 'unsupported') return 'capabilityUnsupported';
  if (typeof reason === 'string') {
    if (/timed?\s*out|timeout|duration budget/i.test(reason))
      return 'requestTimedOut';
    if (
      /(?:audit|whois|request|input|response).*budget.*exceeded/i.test(reason)
    )
      return 'budgetExhausted';
    if (
      [
        'baseline_required',
        'tokenizer_bank_required',
        'numeric_reference_required',
        'A trusted reference endpoint is required',
      ].includes(reason)
    )
      return 'referenceRequired';
    if (
      [
        'numeric_model_reference_missing',
        'tokenizer_model_reference_missing',
        'unknown_claim',
      ].includes(reason)
    )
      return 'modelReferenceMissing';
    if (
      [
        'stale_baseline',
        'stale_tokenizer_bank',
        'stale_numeric_reference',
      ].includes(reason)
    )
      return 'referenceExpired';
  }
  if (observations.outcome === 'unparseable') return 'unparseableResponse';
  if (observations.outcome === 'incomplete') return 'incompleteResponse';
  if (observations.outcome === 'safety_refusal') return 'probeRefused';
  if (observations.outcome === 'unexpected_stream') return 'unexpectedStream';
  if (observations.outcome === 'missing_measurement') return 'missingUsage';
  if (observations.outcome === 'error') return 'requestFailed';
  if (
    observations.assessmentReason === 'ambiguous_response' ||
    (observations.outcome === 'answer' &&
      observations.disclosed === false &&
      observations.controlled === false)
  )
    return 'ambiguousDisclosure';
  return null;
}

const assessmentMessages: Record<string, { en: string; zh: string }> = {
  accessDenied: {
    en: 'Access denied (HTTP 401/403); this check could not acquire a valid answer.',
    zh: '访问被拒绝（HTTP 401/403），本项未获取到有效回答。',
  },
  rateLimited: {
    en: 'Rate limited (HTTP 429); no valid sample was acquired.',
    zh: '接口限流（HTTP 429），本项未取得有效样本。',
  },
  upstreamUnavailable: {
    en: 'The gateway or upstream service failed; no usable sample was acquired.',
    zh: '网关或上游服务异常，本项未取得可用样本。',
  },
  capabilityUnsupported: {
    en: 'The endpoint reported this feature or request parameter as unsupported.',
    zh: '接口明确表示不支持本项能力或请求参数。',
  },
  budgetExhausted: {
    en: 'The audit reached its request or input budget; remaining samples were not collected.',
    zh: '检测达到请求次数或输入预算上限，剩余样本没有采集。',
  },
  requestTimedOut: {
    en: 'The request timed out before a complete sample was acquired.',
    zh: '请求超时，未取得完整样本。',
  },
  referenceRequired: {
    en: 'A compatible reference baseline is required before this comparison can run.',
    zh: '缺少兼容的参考基线，本项对照尚未执行。',
  },
  modelReferenceMissing: {
    en: 'The reference bank has no usable fingerprint data for this model. The check was skipped without sending model requests.',
    zh: '参考库没有当前模型的可用指纹数据，已跳过检测，未发送模型请求。',
  },
  referenceExpired: {
    en: 'The reference baseline has expired; no fresh identity conclusion is issued.',
    zh: '参考基线已过期，本次不据此给出模型身份结论。',
  },
  unparseableResponse: {
    en: 'A response arrived but could not be parsed as the requested protocol.',
    zh: '接口已返回内容，但无法按所选协议解析。',
  },
  incompleteResponse: {
    en: 'The response was incomplete; required output or terminal events are missing.',
    zh: '响应不完整，缺少必要输出或结束事件。',
  },
  probeRefused: {
    en: 'The model refused this task, so the requested capability was not measured.',
    zh: '模型拒绝了本项任务，因此没有测得相应能力。',
  },
  unexpectedStream: {
    en: 'An SSE stream was returned for a non-streaming request.',
    zh: '请求指定了非流式响应，接口却返回 SSE 流。',
  },
  missingUsage: {
    en: 'The response omitted usage or model measurements required for comparison.',
    zh: '响应缺少对照所需的用量或模型字段。',
  },
  requestFailed: {
    en: 'The request failed before a usable response was acquired.',
    zh: '请求在取得可用响应前失败。',
  },
  ambiguousDisclosure: {
    en: 'The answer is ambiguous: it neither clearly refuses extraction nor establishes a recognizable extraction result.',
    zh: '已收到回答，但提取结果含糊，既没有明确拒绝，也没有可识别的提取结果。',
  },
  explicit_refusal: {
    en: 'The model explicitly refused extraction; no disclosure signal was observed in this challenge.',
    zh: '模型已明确拒绝提取，本次挑战未观察到泄漏线索。',
  },
  empty_extraction: {
    en: 'The model returned an empty extraction result; no hidden instruction content was obtained.',
    zh: '返回空提取结果，本次未获得隐藏指令内容。',
  },
};

export function getAuditAssessmentMessage(
  observations: Record<string, unknown>,
  locale: 'en' | 'zh',
  inconclusive = true
) {
  const assessment = observations.assessmentReason;
  const reason =
    typeof assessment === 'string' &&
    Object.hasOwn(assessmentMessages, assessment)
      ? assessment
      : inconclusive
        ? getAuditInconclusiveReason(observations)
        : null;
  return reason ? (assessmentMessages[reason]?.[locale] ?? null) : null;
}
