export const relayAuditVerdicts = [
  'trusted',
  'caution',
  'high_risk',
  'unknown',
] as const;

export const relayAuditCategories = [
  'model_authenticity',
  'hidden_prompt',
  'instruction_control',
  'prompt_leakage',
  'stream_integrity',
  'error_leakage',
] as const;

export const relayAuditSeverities = [
  'safe',
  'info',
  'warning',
  'critical',
  'unknown',
] as const;

export const relayAuditProgressStages = [
  'infrastructure_recon',
  'model_list',
  'token_injection',
  'prompt_extraction',
  'instruction_conflict',
  'jailbreak_identity',
  'context_window',
  'tool_substitution',
  'error_leakage',
  'stream_integrity',
  'web3_prompt_injection',
  'infrastructure_fingerprint',
  'latency_variance',
  'tool_calling',
  'structured_output',
  'image_understanding',
  'pdf_understanding',
  'context_recall',
  'stream_consistency',
  'quality_canary',
  'quality_comparison',
  'model_fingerprint',
  'numeric_fingerprint',
  'tokenizer_fingerprint',
  'conditional_injection',
  'report',
] as const;

export const relayAuditProgressStatuses = [
  'pending',
  'running',
  'completed',
  'failed',
] as const;

export const relayAuditCheckGroupIds = [
  'endpoint_profile',
  'model_authenticity',
  'prompt_security',
  'response_integrity_stability',
  // Legacy ids kept for stored audit summaries created before the merge.
  'response_integrity',
  'leakage_stability',
] as const;

const relayAuditCompletionStatuses = ['complete', 'blocked'] as const;

const relayAuditCompletionReasons = [
  'quota_limited',
  'model_unavailable',
  'auth_failed',
  'rate_limited',
  'request_rejected',
  'upstream_error',
  'request_failed',
] as const;

export type RelayAuditVerdict = (typeof relayAuditVerdicts)[number];
export type RelayAuditCategory = (typeof relayAuditCategories)[number];
export type RelayAuditSeverity = (typeof relayAuditSeverities)[number];
export type RelayAuditRiskState =
  | 'healthy'
  | 'review'
  | 'risk_found'
  | 'high_risk'
  | 'inconclusive';
export type RelayAuditProgressStageId =
  (typeof relayAuditProgressStages)[number];
export type RelayAuditProgressStatus =
  (typeof relayAuditProgressStatuses)[number];
export type RelayAuditCheckGroupId = (typeof relayAuditCheckGroupIds)[number];
export type RelayAuditCompletionStatus =
  (typeof relayAuditCompletionStatuses)[number];
export type RelayAuditCompletionReason =
  (typeof relayAuditCompletionReasons)[number];

export type RelayAuditEngineStepId = Exclude<
  RelayAuditProgressStageId,
  'report'
>;

export type RelayAuditEngineStatus =
  | 'completed'
  | 'blocked'
  | 'inconclusive'
  | 'failed';

export type RelayAuditEngineTestStatus =
  | 'passed'
  | 'failed'
  | 'warning'
  | 'blocked'
  | 'inconclusive';

export type RelayAuditEngineValue =
  | string
  | number
  | boolean
  | null
  | undefined;

export type RelayAuditEngineEvidence = {
  labelZh: string;
  labelEn: string;
  value: RelayAuditEngineValue;
  severity?: RelayAuditSeverity;
};

export type RelayAuditStoredEvidence = {
  key: string;
  value: RelayAuditEngineValue;
  severity?: RelayAuditSeverity;
};

export type RelayAuditEngineTable = {
  id: string;
  titleZh: string;
  titleEn: string;
  columns: Array<{
    key: string;
    labelZh: string;
    labelEn: string;
  }>;
  rows: Array<Record<string, RelayAuditEngineValue>>;
};

export type RelayAuditStoredTable = {
  id: string;
  columns: Array<{
    key: string;
  }>;
  rows: Array<Record<string, RelayAuditEngineValue>>;
};

export type RelayAuditEngineTest = {
  id: string;
  titleZh: string;
  titleEn: string;
  term: string;
  status: RelayAuditEngineTestStatus;
  severity: RelayAuditSeverity;
  resultZh: string;
  resultEn: string;
  plainLanguageZh: string;
  plainLanguageEn: string;
  evidenceZh: string;
  evidenceEn: string;
};

export type RelayAuditStoredTest = {
  id: string;
  term: string;
  status: RelayAuditEngineTestStatus;
  severity: RelayAuditSeverity;
  titleZh?: string;
  titleEn?: string;
  resultZh?: string;
  resultEn?: string;
  plainLanguageZh?: string;
  plainLanguageEn?: string;
  evidenceZh?: string;
  evidenceEn?: string;
};

export type RelayAuditEngineStep = {
  id: RelayAuditEngineStepId;
  titleZh: string;
  titleEn: string;
  status: RelayAuditEngineStatus;
  severity: RelayAuditSeverity;
  durationMs: number;
  summaryZh: string;
  summaryEn: string;
  tests: RelayAuditEngineTest[];
  tables: RelayAuditEngineTable[];
  evidence: RelayAuditEngineEvidence[];
  rawRedactedPreview?: string;
};

export type RelayAuditStoredStep = {
  id: RelayAuditEngineStepId;
  status: RelayAuditEngineStatus;
  severity: RelayAuditSeverity;
  durationMs: number;
  tests: RelayAuditStoredTest[];
  tables: RelayAuditStoredTable[];
  evidence: RelayAuditStoredEvidence[];
  rawRedactedPreview?: string;
};

export type RelayAuditEngineSignals = {
  requestedModelFamily?: string;
  detectedModelFamily?: string;
  modelListCount?: number;
  framework?: string;
  quotaLimited?: boolean;
  modelUnavailable?: boolean;
  promptLeaked?: boolean;
  instructionOverridden?: boolean;
  toolSubstitutionDetected?: boolean;
  errorLeakageDetected?: boolean;
  streamAnomalyDetected?: boolean;
  web3InjectionDetected?: boolean;
  maxContextCharsPassed?: number;
  latencyVerdict?:
    | 'stable'
    | 'variable'
    | 'high-variance'
    | 'bimodal'
    | 'inconclusive';
};

export type AuditProvenance = {
  engineVersion: string;
  rulesetVersion: string;
  upstreamCommit?: string;
  assessmentPolicy: string;
  coverage?: { requested: string[]; inconclusive: string[] };
};

export type RelayAuditEngineOutput = {
  provenance?: AuditProvenance;
  version: 'lmspeed-relay-audit-node-v1';
  targetUrl: string;
  modelId: string;
  startedAt: string;
  finishedAt: string;
  summary: {
    verdict: RelayAuditVerdict;
    headlineZh: string;
    headlineEn: string;
    completionStatus?: RelayAuditCompletionStatus;
    completionReason?: RelayAuditCompletionReason;
  };
  signals: RelayAuditEngineSignals;
  requestedStepIds?: RelayAuditEngineStepId[];
  steps: RelayAuditEngineStep[];
};

export type RelayAuditStoredFactOutput = {
  provenance?: AuditProvenance;
  version: 'lmspeed-relay-audit-facts-v1';
  engineVersion: RelayAuditEngineOutput['version'];
  targetUrl: string;
  modelId: string;
  startedAt: string;
  finishedAt: string;
  summary: {
    verdict: RelayAuditVerdict;
    completionStatus?: RelayAuditCompletionStatus;
    completionReason?: RelayAuditCompletionReason;
  };
  signals: RelayAuditEngineSignals;
  requestedStepIds?: RelayAuditEngineStepId[];
  steps: RelayAuditStoredStep[];
};

export type RelayAuditPersistedAuditOutput =
  | RelayAuditEngineOutput
  | RelayAuditStoredFactOutput;

export type RelayAuditProgressEvent = {
  event: 'progress';
  stage: RelayAuditProgressStageId;
  status: Exclude<RelayAuditProgressStatus, 'pending'>;
  severity?: RelayAuditSeverity;
  message?: string;
  messageZh?: string;
  messageEn?: string;
};

export type RelayAuditProgressStep = {
  id: RelayAuditProgressStageId;
  status: RelayAuditProgressStatus;
  severity: RelayAuditSeverity;
  message?: string;
  messageZh?: string;
  messageEn?: string;
  updatedAt?: string;
};

export type RelayAuditProgressSnapshot = {
  stages: RelayAuditProgressStep[];
  activeStage: RelayAuditProgressStageId | null;
  percent: number;
  updatedAt: string;
};
