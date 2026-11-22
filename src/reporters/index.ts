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
    lines.push(`- ${probe.id}: ${probe.execution} / ${probe.verdict}`);
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
