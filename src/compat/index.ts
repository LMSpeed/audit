export { latencyStatistics as classifyRelayAuditLatencyVariance } from '../probes/boundaries.js';
export type { RelayAuditEngineOptions, RelayAuditInput } from './engine.js';
export {
  runLmspeedAudit,
  runLmspeedAudit as runRelayAudit,
} from './lmspeed.js';
export type * from './types.js';
