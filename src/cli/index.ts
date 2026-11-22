#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import {
  loadAuditConfiguration,
  loadFingerprintCollection,
} from '../configuration.js';
import {
  AUDIT_PROBE_IDS,
  collectFingerprintBaseline,
  ENGINE_VERSION,
  runAudit,
} from '../index.js';
import { redactRelayAuditText } from '../redaction.js';
import { renderReport } from '../reporters/index.js';
import type { AuditProfile, AuditProtocol } from '../schema/index.js';

let credential = '';
try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    strict: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      version: { type: 'boolean' },
      url: { type: 'string' },
      model: { type: 'string' },
      protocol: { type: 'string' },
      profile: { type: 'string' },
      probes: { type: 'string' },
      format: { type: 'string' },
      output: { type: 'string' },
      config: { type: 'string' },
      'key-env': { type: 'string' },
      'allow-private': { type: 'boolean' },
      thinking: { type: 'boolean' },
      'context-tokens': { type: 'string' },
      'max-requests': { type: 'string' },
      'max-input-tokens': { type: 'string' },
      'max-duration-ms': { type: 'string' },
      'max-response-bytes': { type: 'string' },
      'pace-ms': { type: 'string' },
    },
  });
  if (values.version) process.stdout.write(`${ENGINE_VERSION}\n`);
  else if (values.help || !positionals.length)
    process.stdout.write(
      'lmspeed-audit scan --url <base-url> --model <model-id> [--protocol auto|openai|anthropic|responses] [--profile connectivity|general|web3|full] [--probes id,id] [--config local.json] [--format json|markdown|text] [--key-env PROVIDER_API_KEY] [--output new-file]\nlmspeed-audit collect-baseline --config collection.json [--output new-file]\nlmspeed-audit list [--format json]\nCredentials are read from environment variables. Local HTTP/private targets require --allow-private. All target, reference and judge requests share resource limits. Exit: 0 no findings, 1 findings, 2 incomplete/error.\nOnline audit and shareable reports: https://lmspeed.net/audit\n'
    );
  else if (positionals[0] === 'list' && positionals.length === 1)
    process.stdout.write(
      values.format === 'json'
        ? `${JSON.stringify(AUDIT_PROBE_IDS)}\n`
        : `${AUDIT_PROBE_IDS.join('\n')}\n`
    );
  else if (positionals[0] === 'collect-baseline' && positionals.length === 1) {
    if (!values.config) throw new Error('collect-baseline requires --config');
    const positive = (value: string | undefined) => {
      if (value === undefined) return undefined;
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n <= 0)
        throw new Error('Collection budgets must be positive integers');
      return n;
    };
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Collection cancelled'));
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const collected = await collectFingerprintBaseline(
        await loadFingerprintCollection(values.config),
        {
          signal: controller.signal,
          networkPolicy: values['allow-private'] ? 'local' : 'public',
          limits: {
            maxRequests: positive(values['max-requests']),
            maxInputTokens: positive(values['max-input-tokens']),
            maxDurationMs: positive(values['max-duration-ms']),
            maxResponseBytes: positive(values['max-response-bytes']),
          },
        }
      );
      const rendered = `${JSON.stringify(collected, null, 2)}\n`;
      if (values.output)
        await writeFile(values.output, rendered, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
      else process.stdout.write(rendered);
      process.exitCode =
        collected.baseline.calibration.status === 'validated' ? 0 : 2;
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
  } else {
    if (positionals[0] !== 'scan' || positionals.length !== 1)
      throw new Error('Expected scan or list command');
    if (!values.url || !values.model)
      throw new Error('--url and --model are required');
    const configuration = values.config
      ? await loadAuditConfiguration(values.config)
      : {};
    const format = values.format ?? 'json';
    if (!['json', 'markdown', 'text'].includes(format))
      throw new Error('Unknown report format');
    credential = process.env[values['key-env'] ?? 'PROVIDER_API_KEY'] ?? '';
    if (!credential) throw new Error('API key environment variable is empty');
    const integer = (key: keyof typeof values) => {
      const raw = values[key];
      if (raw === undefined) return undefined;
      const number = Number(raw);
      if (!Number.isSafeInteger(number) || number < 0)
        throw new Error(`--${key} must be a nonnegative integer`);
      return number;
    };
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error('Audit cancelled'));
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    try {
      const report = await runAudit(
        {
          ...configuration,
          target: {
            baseUrl: values.url,
            modelId: values.model,
            protocol: (values.protocol ?? 'auto') as AuditProtocol,
          },
          apiKey: credential,
          profile: (values.profile ??
            configuration.profile ??
            'general') as AuditProfile,
          probes:
            values.probes?.split(',').map((id) => id.trim()) ??
            configuration.probes,
          capabilities: {
            ...configuration.capabilities,
            ...(values.thinking !== undefined
              ? { thinking: values.thinking }
              : {}),
            ...(values['context-tokens'] !== undefined
              ? { contextWindowTokens: integer('context-tokens') }
              : {}),
          },
        },
        {
          signal: controller.signal,
          networkPolicy: values['allow-private'] ? 'local' : 'public',
          pacingMs: integer('pace-ms'),
          limits: {
            maxRequests: integer('max-requests'),
            maxInputTokens: integer('max-input-tokens'),
            maxDurationMs: integer('max-duration-ms'),
            maxResponseBytes: integer('max-response-bytes'),
          },
        }
      );
      const rendered = renderReport(
        report,
        format as 'json' | 'markdown' | 'text'
      );
      if (values.output)
        await writeFile(values.output, rendered, {
          encoding: 'utf8',
          mode: 0o600,
          flag: 'wx',
        });
      else process.stdout.write(rendered);
      process.exitCode =
        report.assessment.verdict === 'findings'
          ? 1
          : report.assessment.verdict === 'inconclusive'
            ? 2
            : 0;
    } finally {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    }
  }
} catch (error) {
  const message = error instanceof Error ? error.message : 'Audit failed';
  process.stderr.write(
    `${redactRelayAuditText(credential ? message.split(credential).join('[redacted-key]') : message)}\n`
  );
  process.exitCode = 2;
}
