import type { RelayAuditSeverity } from '../compat/types.js';
import { object, type ResolvedProtocol } from './completion.js';

export function parseSseData(text: string) {
  const messages: string[] = [];
  let data: string[] = [];
  for (const line of text.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)) {
    if (!line) {
      if (data.length) messages.push(data.join('\n'));
      data = [];
    } else {
      const colon = line.indexOf(':');
      const name = colon < 0 ? line : line.slice(0, colon);
      if (name === 'data')
        data.push(colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, ''));
    }
  }
  // An event needs a blank line to dispatch; an incomplete trailing event is omitted.
  return messages;
}
export type RelayAuditSseAnalysis = {
  severity: RelayAuditSeverity;
  eventCount: number;
  transportOk: boolean;
  modelCompatible: boolean | null;
  usageMonotonic: boolean | null;
  usageConsistent: boolean | null;
  signatureValid: boolean | null;
  streamComplete: boolean | null;
  streamModel: string | null;
  findings: string[];
};
export function analyzeRelayAuditSseText(input: {
  expectedModelId: string;
  protocol: ResolvedProtocol;
  text: string;
  httpStatus?: number;
}): RelayAuditSseAnalysis {
  const { protocol } = input;
  const transportOk =
    input.httpStatus === undefined ||
    (input.httpStatus >= 200 && input.httpStatus < 300);
  const analysis: RelayAuditSseAnalysis = {
    severity: 'warning',
    eventCount: 0,
    transportOk,
    modelCompatible: null,
    usageMonotonic: null,
    usageConsistent: null,
    signatureValid: null,
    streamComplete: null,
    streamModel: null,
    findings: [],
  };
  if (!transportOk) return analysis;
  let ended = false;
  let started = protocol === 'openai';
  let substantial = false;
  let lastOutput: number | undefined;
  let firstInput: number | undefined;
  const issue = (description: string) => analysis.findings.push(description);
  for (const data of parseSseData(input.text)) {
    if (data === '[DONE]') {
      if (protocol !== 'openai' || ended)
        issue('Unexpected or repeated terminal marker');
      ended = true;
      continue;
    }
    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(data);
      if (typeof value !== 'object' || value === null || Array.isArray(value))
        throw new Error('Invalid envelope');
      event = object(value);
    } catch {
      issue('SSE payload is not a JSON object');
      continue;
    }
    analysis.eventCount++;
    if (event.type === 'ping') continue;
    substantial = true;
    if (ended) issue('Model data follows the terminal marker');
    if (
      event.type === 'error' ||
      event.error ||
      event.type === 'response.failed' ||
      event.type === 'response.incomplete'
    )
      issue('Stream contains an error or incomplete event');
    const envelope =
      protocol === 'anthropic'
        ? object(event.message)
        : protocol === 'responses'
          ? object(event.response)
          : event;
    const model = envelope.model;
    if (typeof model === 'string') {
      analysis.streamModel ??= model;
      if (model !== input.expectedModelId) {
        analysis.modelCompatible = false;
        issue(
          'Returned model identifier differs from the requested identifier'
        );
      } else analysis.modelCompatible ??= true;
    }
    if (
      (protocol === 'anthropic' && event.type === 'message_start') ||
      (protocol === 'responses' && event.type === 'response.created')
    ) {
      if (started) issue('Repeated stream start');
      started = true;
    }
    if (
      (protocol === 'anthropic' && event.type === 'message_stop') ||
      (protocol === 'responses' && event.type === 'response.completed')
    ) {
      if (!started) issue('Terminal event precedes stream start');
      ended = true;
    }
    const usage = { ...object(envelope.usage), ...object(event.usage) };
    const inputCount =
      protocol === 'openai' ? usage.prompt_tokens : usage.input_tokens;
    const outputCount =
      protocol === 'openai' ? usage.completion_tokens : usage.output_tokens;
    if (typeof inputCount === 'number') {
      analysis.usageConsistent ??= true;
      firstInput ??= inputCount;
      if (
        !Number.isSafeInteger(inputCount) ||
        inputCount < 0 ||
        firstInput !== inputCount
      )
        analysis.usageConsistent = false;
    }
    if (typeof outputCount === 'number') {
      analysis.usageMonotonic ??= true;
      if (
        !Number.isSafeInteger(outputCount) ||
        outputCount < 0 ||
        (lastOutput !== undefined && outputCount < lastOutput)
      )
        analysis.usageMonotonic = false;
      lastOutput = outputCount;
    }
    const delta = object(event.delta);
    if (delta.type === 'signature_delta') {
      analysis.signatureValid ??= true;
      if (typeof delta.signature !== 'string' || !delta.signature.trim())
        analysis.signatureValid = false;
    }
  }
  if (!substantial && !analysis.findings.length) return analysis;
  analysis.streamComplete = started && ended;
  if (!analysis.streamComplete)
    issue('Required stream start or termination is missing');
  if (!analysis.streamModel)
    issue('No model identifier was supplied in the stream');
  if (analysis.usageMonotonic === false)
    issue('Reported output usage decreased or was invalid');
  if (analysis.usageConsistent === false)
    issue('Reported input usage changed or was invalid');
  if (analysis.signatureValid === false)
    issue('Thinking signature payload is empty');
  analysis.findings = [...new Set(analysis.findings)];
  analysis.severity = analysis.findings.length ? 'critical' : 'safe';
  return analysis;
}
