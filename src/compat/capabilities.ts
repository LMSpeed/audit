import { getRelayAuditStepById } from '../catalog.js';
import { getAuditAssessmentMessage } from '../probes/assessment.js';
import {
  createPromptReportColumns,
  formatPromptReportTokens,
} from '../probes/prompts.js';
import type { ProbeResult } from '../schema/index.js';
import type { RelayAuditEngineStep } from './types.js';

export function capabilityStep(probe: ProbeResult): RelayAuditEngineStep {
  const definition = getRelayAuditStepById(probe.id);
  if (!definition) throw new Error(`Missing probe definition: ${probe.id}`);
  const severity =
    probe.verdict === 'finding'
      ? probe.findings.some((finding) => finding.severity === 'critical')
        ? 'critical'
        : 'warning'
      : probe.verdict === 'inconclusive'
        ? 'unknown'
        : 'safe';
  const observedSummary =
    probe.id === 'context_window' ||
    (probe.id === 'web3_prompt_injection' &&
      (probe.observations.assessmentReason === 'walletReviewPass' ||
        probe.observations.assessmentReason === 'walletReviewFail'))
      ? {
          zh: getAuditAssessmentMessage(probe.observations, 'zh'),
          en: getAuditAssessmentMessage(probe.observations, 'en'),
        }
      : null;
  const explanation =
    observedSummary?.zh && observedSummary.en
      ? { zh: observedSummary.zh, en: observedSummary.en }
      : probe.verdict === 'finding'
        ? {
            zh: '发现契约差异，请结合证据复核。',
            en: 'Observed a contract difference; review the evidence.',
          }
        : probe.verdict === 'inconclusive'
          ? {
              zh:
                getAuditAssessmentMessage(probe.observations, 'zh') ??
                '没有足够证据完成此检测。',
              en:
                getAuditAssessmentMessage(probe.observations, 'en') ??
                'Insufficient evidence to complete this check.',
            }
          : {
              zh: '本次请求满足所测契约。',
              en: 'This run satisfied the tested contract.',
            };
  const tests = ['unsupported', 'skipped'].includes(probe.execution)
    ? []
    : probe.findings.length
      ? probe.findings.map((f) => ({ code: f.code, evidence: f.evidence }))
      : [
          {
            code: probe.id,
            evidence: `${typeof probe.observations.status === 'number' && probe.observations.status > 0 ? `HTTP ${probe.observations.status}; ` : ''}${JSON.stringify(probe.observations)}`,
          },
        ];
  return {
    id: definition.id,
    titleZh: definition.titleZh,
    titleEn: definition.titleEn,
    status:
      probe.execution === 'blocked'
        ? 'blocked'
        : probe.execution === 'error'
          ? 'failed'
          : probe.verdict === 'inconclusive'
            ? 'inconclusive'
            : 'completed',
    severity,
    durationMs: probe.durationMs,
    summaryZh: explanation.zh,
    summaryEn: explanation.en,
    tests: probe.checks
      ? probe.checks.map((check) => ({
          id: check.id,
          titleZh: check.titleZh,
          titleEn: check.titleEn,
          term: definition.titleEn,
          status:
            check.execution === 'blocked' || check.execution === 'error'
              ? ('blocked' as const)
              : check.verdict === 'finding'
                ? check.observations.disclosureVerdict === 'review'
                  ? ('warning' as const)
                  : ('failed' as const)
                : check.verdict === 'pass'
                  ? ('passed' as const)
                  : ('inconclusive' as const),
          severity:
            check.verdict === 'finding'
              ? check.observations.disclosureVerdict === 'fail'
                ? ('critical' as const)
                : ('warning' as const)
              : check.verdict === 'inconclusive'
                ? ('unknown' as const)
                : check.informational
                  ? ('info' as const)
                  : ('safe' as const),
          resultZh:
            check.verdict === 'finding'
              ? (getAuditAssessmentMessage(check.observations, 'zh', false) ??
                '发现泄漏线索，请复核证据。')
              : check.verdict === 'inconclusive'
                ? (getAuditAssessmentMessage(
                    check.observations,
                    'zh',
                    check.verdict === 'inconclusive'
                  ) ?? '未收集到足够证据。')
                : (getAuditAssessmentMessage(check.observations, 'zh', false) ??
                  (check.informational
                    ? '已采集。'
                    : '本次挑战未观察到泄漏。')),
          resultEn:
            check.verdict === 'finding'
              ? (getAuditAssessmentMessage(check.observations, 'en', false) ??
                'Disclosure signal observed; review the evidence.')
              : check.verdict === 'inconclusive'
                ? (getAuditAssessmentMessage(
                    check.observations,
                    'en',
                    check.verdict === 'inconclusive'
                  ) ?? 'Insufficient evidence.')
                : (getAuditAssessmentMessage(check.observations, 'en', false) ??
                  (check.informational
                    ? 'Collected.'
                    : 'No disclosure observed in this challenge.')),
          plainLanguageZh: definition.descriptionZh,
          plainLanguageEn: definition.descriptionEn,
          evidenceZh: JSON.stringify(check.observations),
          evidenceEn: JSON.stringify(check.observations),
        }))
      : tests.map((test) => ({
          id: test.code,
          titleZh: definition.titleZh,
          titleEn: definition.titleEn,
          term: definition.titleEn,
          status: ['blocked', 'error'].includes(probe.execution)
            ? 'blocked'
            : probe.verdict === 'finding'
              ? 'failed'
              : probe.verdict === 'inconclusive'
                ? 'inconclusive'
                : 'passed',
          severity,
          resultZh: explanation.zh,
          resultEn: explanation.en,
          plainLanguageZh: definition.descriptionZh,
          plainLanguageEn: definition.descriptionEn,
          evidenceZh: test.evidence,
          evidenceEn: test.evidence,
        })),
    tables:
      probe.checks &&
      ['prompt_extraction', 'jailbreak_identity'].includes(probe.id)
        ? [
            {
              id: probe.id,
              titleZh: definition.titleZh,
              titleEn: definition.titleEn,
              columns: createPromptReportColumns(),
              rows: probe.checks.map((check) => ({
                probe: check.id,
                systemPrompt: String(check.observations.systemPrompt ?? '-'),
                userPrompt: String(check.observations.userPrompt ?? ''),
                response: String(check.observations.response ?? ''),
                tokens: formatPromptReportTokens(
                  typeof check.observations.reportedInputTokens === 'number'
                    ? check.observations.reportedInputTokens
                    : null
                ),
                verdict:
                  typeof check.observations.disclosureVerdict === 'string'
                    ? check.observations.disclosureVerdict
                    : check.verdict,
              })),
            },
          ]
        : [],
    evidence: [
      {
        labelZh: '检测观测',
        labelEn: 'Observations',
        value: JSON.stringify(probe.observations),
        severity,
      },
    ],
  };
}
