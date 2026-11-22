import { executeAudit } from './engine.js';
import type { AuditInput, AuditOptions } from './schema/index.js';

export type { AuditConfiguration } from './configuration.js';
export { loadAuditConfiguration } from './configuration.js';
export {
  AUDIT_PROBE_IDS,
  createAuditPlan,
  ENGINE_VERSION,
  RULESET_VERSION,
} from './engine.js';
export { collectFingerprintBaseline } from './identity/collect.js';
export type { TokenizerBank } from './identity/tokenizer-bank.js';
export type * from './schema/index.js';
export async function runAudit(input: AuditInput, options: AuditOptions = {}) {
  return (await executeAudit(input, options)).report;
}
