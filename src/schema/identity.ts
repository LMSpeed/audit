import type { AuditInput, AuditTarget } from './index.js';

export type FingerprintContract = {
  protocol: 'openai' | 'anthropic' | 'responses';
  prompts: string[];
  generation: NonNullable<AuditInput['generation']>;
  samplesPerPrompt: number;
};
export type FingerprintSource = {
  id: string;
  kind: 'candidate' | 'other';
  target: AuditTarget;
  apiKey: string;
};
export type FingerprintCollection = {
  contract: FingerprintContract;
  sources: FingerprintSource[];
  maxAgeDays?: number;
};
export type FingerprintBaseline = {
  schemaVersion: '1';
  id: string;
  createdAt: string;
  expiresAt: string;
  contract: FingerprintContract;
  sources: Array<{
    id: string;
    kind: 'candidate' | 'other';
    training: Array<Record<string, number>>;
    validation: Array<Record<string, number>>;
  }>;
  calibration: {
    status: 'validated' | 'insufficient';
    method: 'independent-holdout-v1';
    minimumMargin: number;
    minimumLogLikelihood: Record<string, number | null>;
    heldOutCorrect: number;
    heldOutTotal: number;
  };
};
