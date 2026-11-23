import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { TokenizerBank } from './identity/tokenizer-bank.js';
import { object } from './protocols/completion.js';
import type {
  AuditInput,
  AuditTarget,
  FingerprintBaseline,
  FingerprintCollection,
} from './schema/index.js';

export type AuditConfiguration = Omit<
  AuditInput,
  'target' | 'apiKey' | 'collection'
>;
async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8'));
}
function endpoint(value: unknown) {
  const config = object(value);
  if (config.apiKey !== undefined)
    throw new Error('Use apiKeyEnv for configuration credentials');
  const keyEnv = config.apiKeyEnv;
  if (typeof keyEnv !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyEnv))
    throw new Error('Expected apiKeyEnv naming an environment variable');
  const apiKey = process.env[keyEnv];
  if (!apiKey?.trim())
    throw new Error(`Credential environment variable ${keyEnv} is empty`);
  return { target: config.target as AuditTarget, apiKey };
}
export async function loadAuditConfiguration(
  path: string
): Promise<AuditConfiguration> {
  const config = object(await readJson(path));
  const allowed = [
    'profile',
    'probes',
    'capabilities',
    'generation',
    'context',
    'contextSearch',
    'reference',
    'judge',
    'identity',
    'tokenizer',
    'numericFingerprint',
    'referenceData',
  ];
  if (Object.keys(config).some((key) => !allowed.includes(key)))
    throw new Error('Unknown audit configuration field');
  const result = { ...config } as AuditConfiguration;
  const base = dirname(resolve(path));
  if (config.reference) result.reference = endpoint(config.reference);
  if (config.judge)
    result.judge = {
      ...endpoint(config.judge),
      minimumScore: object(config.judge).minimumScore as number | undefined,
    };
  const identity = object(config.identity);
  if (identity.baselineFile) {
    if (typeof identity.baselineFile !== 'string')
      throw new Error('baselineFile must be a local path');
    const saved = await readJson(resolve(base, identity.baselineFile));
    result.identity = {
      baseline: (object(saved).baseline ?? saved) as FingerprintBaseline,
      claimedModel: identity.claimedModel as string,
      samplesPerPrompt: identity.samplesPerPrompt as number | undefined,
    };
  }
  const tokenizer = object(config.tokenizer);
  if (tokenizer.bankFile) {
    if (typeof tokenizer.bankFile !== 'string')
      throw new Error('bankFile must be a local path');
    result.tokenizer = {
      bank: (await readJson(
        resolve(base, tokenizer.bankFile)
      )) as TokenizerBank,
      maximumProbes: tokenizer.maximumProbes as number | undefined,
      maxAgeDays: tokenizer.maxAgeDays as number | undefined,
    };
  }
  if (result.numericFingerprint)
    result.numericFingerprint = {
      ...result.numericFingerprint,
      dataDirectory: resolve(base, result.numericFingerprint.dataDirectory),
    };
  return result;
}
export async function loadFingerprintCollection(
  path: string
): Promise<FingerprintCollection> {
  const config = object(await readJson(path));
  if (!Array.isArray(config.sources))
    throw new Error('Collection sources must be an array');
  return {
    contract: config.contract as FingerprintCollection['contract'],
    maxAgeDays: config.maxAgeDays as number | undefined,
    sources: config.sources.map((value) => {
      const source = object(value);
      return {
        ...endpoint(source),
        id: source.id as string,
        kind: source.kind as 'candidate' | 'other',
      };
    }),
  };
}
