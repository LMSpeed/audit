import type { Completion } from '../protocols/completion.js';
import type { Finding, ProbeResult } from '../schema/index.js';

export function result(
  id: string,
  started: number,
  observations: Record<string, unknown>,
  findings: Finding[] = [],
  execution: ProbeResult['execution'] = 'completed',
  inconclusive = false
): ProbeResult {
  return {
    id,
    durationMs: performance.now() - started,
    execution,
    verdict: findings.length
      ? 'finding'
      : inconclusive || execution !== 'completed'
        ? 'inconclusive'
        : 'pass',
    observations,
    findings,
  };
}
export function finding(
  probeId: string,
  code: string,
  evidence: string,
  confidence: Finding['confidence'] = 'moderate'
): Finding {
  return { probeId, code, evidence, confidence, severity: 'warning' };
}
export function unavailable(
  id: string,
  started: number,
  completion: Completion
): ProbeResult {
  return result(
    id,
    started,
    {
      outcome: completion.outcome,
      status: completion.status,
      reason: completion.reason,
    },
    [],
    completion.outcome === 'unsupported'
      ? 'unsupported'
      : completion.outcome === 'http_error'
        ? 'blocked'
        : completion.outcome === 'error'
          ? 'error'
          : 'completed',
    true
  );
}
