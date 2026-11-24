import {
  getAuditAssessmentMessage,
  getAuditContextVerification,
} from '../probes/assessment.js';
import type { AuditReport } from '../schema/index.js';
export function renderReport(
  report: AuditReport,
  format: 'json' | 'markdown' | 'text' = 'json'
) {
  if (format === 'json') return `${JSON.stringify(report, null, 2)}\n`;
  const lines = [
    `${format === 'markdown' ? '# ' : ''}lmspeed-audit audit: ${report.assessment.verdict}`,
    '',
    `Target: ${report.target.baseUrl}`,
    `Model: ${report.target.modelId}`,
    `Engine: ${report.engineVersion}; rules: ${report.rulesetVersion}`,
    `Coverage: ${report.coverage.completed.length}/${report.coverage.requested.length} completed; ${report.coverage.inconclusive.length} inconclusive`,
    '',
  ];
  for (const probe of report.probes) {
    const context =
      probe.id === 'context_window'
        ? getAuditContextVerification(probe.observations)
        : null;
    lines.push(
      `- ${probe.id}: ${probe.execution} / ${context?.verdict ?? probe.verdict}`
    );
    if (context) {
      const summary = getAuditAssessmentMessage(probe.observations, 'en');
      if (summary) lines.push(`  - ${summary}`);
      lines.push(`  - Verification reason: ${context.reason}`);
      if (context.sourceUrl)
        lines.push(`  - Published source: ${context.sourceUrl}`);
    }
    for (const check of probe.checks ?? []) {
      if (typeof check.observations.disclosureVerdict !== 'string') continue;
      const summary = getAuditAssessmentMessage(check.observations, 'en');
      lines.push(
        `  - ${check.id}: ${check.observations.disclosureVerdict}${summary ? ` — ${summary}` : ''}`
      );
    }
    for (const finding of probe.findings)
      lines.push(
        `  - [${finding.severity}; ${finding.confidence}] ${finding.code}: ${finding.evidence.replace(/[\r\n]+/g, ' ')}`
      );
  }
  lines.push(
    '',
    'Findings describe observed behavior and do not certify relay safety or prove upstream model identity.'
  );
  return `${lines.join('\n')}\n`;
}
