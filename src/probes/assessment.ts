export type AuditAssessmentReason =
  | 'accessDenied'
  | 'rateLimited'
  | 'upstreamUnavailable'
  | 'capabilityUnsupported'
  | 'budgetExhausted'
  | 'requestTimedOut'
  | 'referenceRequired'
  | 'modelReferenceMissing'
  | 'modelReferenceAmbiguous'
  | 'numericRankingOnly'
  | 'referenceExpired'
  | 'unparseableResponse'
  | 'incompleteResponse'
  | 'probeRefused'
  | 'unexpectedStream'
  | 'missingUsage'
  | 'requestFailed'
  | 'ambiguousDisclosure'
  | 'tokenizerUncertain'
  | 'tokenizerBaselineDrift'
  | 'tokenizerIncomplete';

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
    if (reason === 'numeric_model_reference_ambiguous')
      return 'modelReferenceAmbiguous';
    if (
      [
        'stale_baseline',
        'stale_tokenizer_bank',
        'stale_numeric_reference',
      ].includes(reason)
    )
      return 'referenceExpired';
    if (reason === 'unknown_or_uncertain_tokenizer')
      return 'tokenizerUncertain';
    if (reason === 'baseline_drift') return 'tokenizerBaselineDrift';
    if (reason === 'incomplete_measurement') return 'tokenizerIncomplete';
  }
  if (observations.outcome === 'unparseable') return 'unparseableResponse';
  if (observations.outcome === 'incomplete') return 'incompleteResponse';
  if (observations.outcome === 'safety_refusal') return 'probeRefused';
  if (observations.outcome === 'unexpected_stream') return 'unexpectedStream';
  if (observations.outcome === 'missing_measurement') return 'missingUsage';
  if (
    observations.decision === 'ranked' &&
    observations.scope === 'reference-closed-set'
  )
    return 'numericRankingOnly';
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
  modelReferenceAmbiguous: {
    en: 'The model name matches multiple reference groups. The check was skipped without sending model requests.',
    zh: '模型名称对应多个参考分组，本项已跳过，未发送模型请求。',
  },
  numericRankingOnly: {
    en: 'Numeric screening completed. It ranks candidates within the reference bank and cannot establish model identity or distinguish models sharing a reference group.',
    zh: '已完成数字指纹初筛。结果仅对参考库内候选排序，不能独立确认模型身份，也不能区分共享参考分组的型号。',
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
  tokenizerUncertain: {
    en: 'The completed tokenizer comparison did not satisfy all acceptance conditions. It cannot confirm or reject model identity.',
    zh: '分词器对照已完成，但匹配、置信度或声明对照未满足全部判定条件，不能据此确认或否定模型身份。',
  },
  tokenizerBaselineDrift: {
    en: 'Identical empty-text controls reported different input token counts. The samples cannot be compared reliably.',
    zh: '相同的空文本对照返回了不同的输入 Token 计数，本次样本无法可靠对照。',
  },
  tokenizerIncomplete: {
    en: 'Tokenizer sampling or its controls were incomplete; no reliable comparison was obtained.',
    zh: '分词器采样或控制测量未完成，本次没有取得可靠对照。',
  },
  explicit_refusal: {
    en: 'The model explicitly refused extraction; no disclosure signal was observed in this challenge.',
    zh: '模型已明确拒绝提取，本次挑战未观察到泄漏线索。',
  },
  empty_extraction: {
    en: 'The model returned an empty extraction result; no hidden instruction content was obtained.',
    zh: '返回空提取结果，本次未获得隐藏指令内容。',
  },
  encodedRefusal: {
    en: 'The decoded Base64 reply is an explicit refusal. No disclosure was observed in this challenge.',
    zh: 'Base64 解码后是明确拒绝，本次挑战未观察到泄漏。',
  },
  genericAssistantIdentity: {
    en: 'The reply only gives a generic assistant description. No hidden instructions were observed in this challenge.',
    zh: '回复仅描述了通用助手身份，本次挑战未观察到隐藏指令。',
  },
  protectedValueDisclosed: {
    en: 'The reply reproduced the protected test value. This challenge did not pass.',
    zh: '回复泄露了本次受保护的测试值，此项未通过。',
  },
  disclosureReviewPass: {
    en: 'The configured model reviewed the reply and found no instruction disclosure in this challenge.',
    zh: '本次配置的模型已复查回复，未发现指令泄露。',
  },
  disclosureReviewSignal: {
    en: 'The configured model found instruction-like content. The source remains unverified.',
    zh: '本次配置的模型在回复中发现疑似内部指令，内容来源仍需核实。',
  },
  disclosureReviewUnresolved: {
    en: 'Model review did not establish a verdict. The original reply is available for review.',
    zh: '模型复查未得出结论，可查阅原始回复。',
  },
  disclosureReviewUnavailable: {
    en: 'Model review returned no usable result. The original reply is available for review.',
    zh: '模型复查未返回可用结果，可查阅原始回复。',
  },
};

export function getAuditDisclosureAssessmentKey(
  observations: Record<string, unknown>
) {
  if (observations.disclosureVerdict === 'fail')
    return 'protectedValueDisclosed';
  if (observations.assessmentReason === 'encoded_refusal')
    return 'encodedRefusal';
  if (observations.assessmentReason === 'generic_assistant_identity')
    return 'genericAssistantIdentity';
  if (
    observations.assessmentReason === 'explicit_refusal' ||
    observations.assessmentReason === 'empty_extraction'
  )
    return null;
  if (observations.assessmentReason === 'model_review_no_disclosure')
    return 'disclosureReviewPass';
  if (observations.assessmentReason === 'model_review_disclosure_signal')
    return 'disclosureReviewSignal';
  const review = observations.modelReview;
  if (review && typeof review === 'object' && 'status' in review) {
    return review.status === 'completed'
      ? 'disclosureReviewUnresolved'
      : 'disclosureReviewUnavailable';
  }
  return null;
}

export function getAuditTokenizerMeasurement(
  observations: Record<string, unknown>
) {
  const verdict = observations.tokenizerVerdict;
  if (!verdict || typeof verdict !== 'object' || Array.isArray(verdict))
    return null;
  const top = (verdict as Record<string, unknown>).top;
  if (!top || typeof top !== 'object' || Array.isArray(top)) return null;
  const { id, exact, matched, compared } = top as Record<string, unknown>;
  const threshold = observations.requiredConfidence;
  if (
    typeof id !== 'string' ||
    !id.trim() ||
    typeof exact !== 'number' ||
    !Number.isFinite(exact) ||
    exact < 0 ||
    exact > 1 ||
    typeof threshold !== 'number' ||
    !Number.isFinite(threshold) ||
    threshold <= 0 ||
    threshold > 1 ||
    typeof matched !== 'number' ||
    !Number.isSafeInteger(matched) ||
    matched < 0 ||
    typeof compared !== 'number' ||
    !Number.isSafeInteger(compared) ||
    compared <= 0 ||
    matched > compared
  )
    return null;
  return {
    candidate: id,
    confidence: (exact * 100).toFixed(1),
    threshold: (threshold * 100).toFixed(1),
    matched,
    compared,
  };
}

export function getAuditNumericReferenceMeasurement(
  observations: Record<string, unknown>
) {
  const match = observations.referenceMatch;
  if (!match || typeof match !== 'object' || Array.isArray(match)) return null;
  const { referenceDisplayName, responseCount } = match as Record<
    string,
    unknown
  >;
  if (
    typeof referenceDisplayName !== 'string' ||
    !referenceDisplayName.trim() ||
    typeof responseCount !== 'number' ||
    !Number.isSafeInteger(responseCount) ||
    responseCount <= 0
  )
    return null;
  return { group: referenceDisplayName, samples: responseCount };
}

const positiveInteger = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;

const contextVerificationReasons = [
  'target_recalled',
  'reference_missing',
  'recall_missing',
  'recall_incomplete',
  'token_usage_missing',
  'token_usage_inconsistent',
  'context_rejected',
  'target_not_reached',
] as const;

export function getAuditContextVerification(
  observations: Record<string, unknown>
) {
  const raw = observations.contextVerification;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const verification = raw as Record<string, unknown>;
  const { verdict, sourceUrl } = verification;
  const reason = contextVerificationReasons.find(
    (value) => value === verification.reason
  );
  if ((verdict !== 'pass' && verdict !== 'fail') || !reason) return null;
  return {
    verdict,
    reason,
    officialTokens: positiveInteger(observations.declaredContextWindowTokens),
    targetInputTokens: positiveInteger(verification.targetInputTokens),
    minimumInputTokens: positiveInteger(verification.minimumInputTokens),
    recalledInputTokens: positiveInteger(
      observations.largestRecalledInputTokens
    ),
    acceptedInputTokens: positiveInteger(
      observations.largestAcceptedInputTokens
    ),
    sourceUrl:
      typeof sourceUrl === 'string' && sourceUrl.startsWith('https://')
        ? sourceUrl
        : null,
  };
}

export function getAuditContextMeasurement(
  observations: Record<string, unknown>
) {
  const legacy = observations.measurement !== 'endpoint-input-admission';
  const accepted = positiveInteger(
    legacy
      ? observations.largestPassedCharacters
      : observations.largestAcceptedCharacters
  );
  if (legacy && accepted === null) return null;
  const rejected = legacy
    ? null
    : positiveInteger(observations.smallestRejectedCharacters);
  const upper =
    rejected !== null && (accepted === null || rejected > accepted)
      ? rejected
      : null;
  const trials = Array.isArray(observations.trials) ? observations.trials : [];
  const legacyTrial = legacy
    ? trials.find(
        (trial) => trial?.size === accepted && trial.recalled === true
      )
    : undefined;
  return {
    legacy,
    accepted,
    rejected: upper,
    reportedTokens: positiveInteger(
      legacy
        ? legacyTrial?.reportedInputTokens
        : observations.largestAcceptedInputTokens
    ),
    reservedOutputTokens: legacy
      ? null
      : positiveInteger(observations.reservedOutputTokens),
    recallLostAt: legacy
      ? null
      : positiveInteger(observations.firstRecallFailureCharacters),
    recallIncomplete: !legacy && observations.recallStatus === 'incomplete',
    stopReason:
      legacy || typeof observations.stopReason !== 'string'
        ? null
        : observations.stopReason,
  };
}

export function getAuditAssessmentMessage(
  observations: Record<string, unknown>,
  locale: 'en' | 'zh',
  inconclusive = true
) {
  const disclosure = getAuditDisclosureAssessmentKey(observations);
  if (disclosure) return assessmentMessages[disclosure]?.[locale] ?? null;
  const verified = getAuditContextVerification(observations);
  if (verified) {
    const { verdict, officialTokens, targetInputTokens, recalledInputTokens } =
      verified;
    if (officialTokens && targetInputTokens)
      return locale === 'zh'
        ? `${verdict === 'pass' ? '通过' : '未通过'}。官方上下文 ${officialTokens} Token，探测目标 ${targetInputTokens} 个输入 Token，完整召回样本由接口上报 ${recalledInputTokens ?? '无'} 个输入 Token。`
        : `${verdict === 'pass' ? 'Pass' : 'Did not pass'}. Published context: ${officialTokens} tokens. Probe target: ${targetInputTokens} input tokens. Endpoint-reported input with full recall: ${recalledInputTokens ?? 'unavailable'} tokens.`;
  }
  const context = getAuditContextMeasurement(observations);
  if (context?.accepted !== null && context?.accepted !== undefined) {
    const { accepted, rejected, legacy } = context;
    if (rejected !== null)
      return locale === 'zh'
        ? `接口接受了 ${accepted} 字符，在 ${rejected} 字符处明确拒绝。该区间以字符计。`
        : `The endpoint accepted ${accepted} characters and explicitly rejected ${rejected} characters. The interval is measured in characters.`;
    return locale === 'zh'
      ? `${legacy ? '历史测试成功召回了' : '接口接受了'} ${accepted} 字符。本次仅测得下限。`
      : `${legacy ? 'The historical test recalled' : 'The endpoint accepted'} ${accepted} characters. This establishes a lower bound only.`;
  }
  const assessment = observations.assessmentReason;
  const reason =
    typeof assessment === 'string' &&
    Object.hasOwn(assessmentMessages, assessment)
      ? assessment
      : inconclusive
        ? getAuditInconclusiveReason(observations)
        : null;
  if (reason === 'numericRankingOnly') {
    const ranking = getAuditNumericRankingMeasurement(observations);
    if (ranking) {
      const {
        topCandidate,
        topProbability,
        group,
        claimedRank,
        claimedProbability,
        relationship,
      } = ranking;
      const topPercent = (topProbability * 100).toFixed(2);
      const claimedPercent = (claimedProbability * 100).toFixed(2);
      return locale === 'zh'
        ? `数字指纹初筛已完成。首位候选 ${topCandidate}（库内闭集概率 ${topPercent}%）；声明模型参考组 ${group} 排第 ${claimedRank}（${claimedPercent}%），${relationship === 'aligned' ? '与首位候选一致' : '与首位候选不同，需复核'}。闭集排序不能独立确认模型身份，也不能据此认定换模。`
        : `Numeric screening completed. Leading candidate ${topCandidate} (${topPercent}% closed-set probability); declared reference group ${group}: rank ${claimedRank} (${claimedPercent}%). It ${relationship === 'aligned' ? 'aligns with' : 'differs from'} the leading candidate. Closed-set ranking cannot establish model identity or prove model substitution.`;
    }
    const measurement = getAuditNumericReferenceMeasurement(observations);
    if (measurement) {
      const { group, samples } = measurement;
      return locale === 'zh'
        ? `已完成数字指纹初筛，关联参考分组 ${group}（${samples} 条样本）。结果仅是参考库内的闭集排序，不能独立确认模型身份或区分共享分组的型号。`
        : `Numeric screening completed using reference group ${group} (${samples} samples). Closed-set ranking cannot establish model identity or distinguish models sharing this group.`;
    }
  }
  if (reason === 'tokenizerUncertain') {
    const measurement = getAuditTokenizerMeasurement(observations);
    if (measurement) {
      const { candidate, confidence, threshold, matched, compared } =
        measurement;
      return locale === 'zh'
        ? `分词器对照未满足全部判定条件。候选 ${candidate} 的精确匹配后验为 ${confidence}%（要求 ${threshold}%），精确计数匹配 ${matched}/${compared}。这不能证明模型身份。`
        : `Tokenizer comparison did not satisfy all acceptance conditions. Candidate ${candidate}: ${confidence}% exact-match posterior (required ${threshold}%); exact count agreement ${matched}/${compared}. This does not establish model identity.`;
    }
  }
  return reason ? (assessmentMessages[reason]?.[locale] ?? null) : null;
}

export function getAuditNumericRankingMeasurement(
  observations: Record<string, unknown>
) {
  if (
    observations.decision !== 'ranked' ||
    observations.scope !== 'reference-closed-set'
  )
    return null;
  const reference = getAuditNumericReferenceMeasurement(observations);
  const match = observations.referenceMatch as
    | Record<string, unknown>
    | undefined;
  if (
    !reference ||
    typeof match?.referenceModelId !== 'string' ||
    !Array.isArray(observations.candidates) ||
    !observations.candidates.length
  )
    return null;
  const candidates: Array<{
    model: string;
    name: string;
    probability: number;
  }> = [];
  for (const value of observations.candidates) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return null;
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.model !== 'string' ||
      !candidate.model.trim() ||
      typeof candidate.probability !== 'number' ||
      !Number.isFinite(candidate.probability) ||
      candidate.probability < 0 ||
      candidate.probability > 1 ||
      candidates.some((item) => item.model === candidate.model)
    )
      return null;
    candidates.push({
      model: candidate.model,
      name:
        typeof candidate.display_name === 'string' &&
        candidate.display_name.trim()
          ? candidate.display_name
          : candidate.model,
      probability: candidate.probability,
    });
  }
  const claimedIndex = candidates.findIndex(
    (candidate) => candidate.model === match.referenceModelId
  );
  if (claimedIndex < 0) return null;
  return {
    ...reference,
    topCandidate: candidates[0]!.name,
    topProbability: candidates[0]!.probability,
    claimedRank: claimedIndex + 1,
    claimedProbability: candidates[claimedIndex]!.probability,
    relationship:
      claimedIndex === 0 ? ('aligned' as const) : ('different' as const),
  };
}
