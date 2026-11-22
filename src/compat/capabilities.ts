import { getRelayAuditStepById } from '../catalog.js';
import type { ProbeResult } from '../schema/index.js';
import type { RelayAuditEngineStep } from './types.js';

export function capabilityStep(probe: ProbeResult): RelayAuditEngineStep {
  const definition = getRelayAuditStepById(probe.id);
  if (!definition) throw new Error(`Missing probe definition: ${probe.id}`);
  const severity =
    probe.verdict === 'finding'
      ? 'warning'
      : probe.verdict === 'inconclusive'
        ? 'unknown'
        : 'safe';
  const explanation =
    probe.verdict === 'finding'
      ? {
          zh: '发现契约差异，请结合证据复核。',
          en: 'Observed a contract difference; review the evidence.',
        }
      : probe.verdict === 'inconclusive'
        ? {
            zh: '没有足够证据完成此检测。',
            en: 'Insufficient evidence to complete this check.',
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
    tests: tests.map((test) => ({
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
    tables: [],
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
