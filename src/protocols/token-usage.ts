import type { AuditTokenUsage } from '../schema/index.js';
import {
  fromEnvelope,
  parseCompletionStream,
  type ResolvedProtocol,
} from './completion.js';

export function createTokenUsageCounter() {
  let modelRequests = 0;
  let inputReportedRequests = 0;
  let outputReportedRequests = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  return {
    begin(url: URL, method: string) {
      const completion = /\/(chat\/completions|messages|responses)\/?$/.exec(
        url.pathname
      );
      if (method !== 'POST' || !completion) return () => {};
      modelRequests++;
      const protocol: ResolvedProtocol =
        completion[1] === 'messages'
          ? 'anthropic'
          : completion[1] === 'responses'
            ? 'responses'
            : 'openai';
      return (raw: string, contentType: string, status: number) => {
        try {
          const parsed =
            contentType.includes('text/event-stream') ||
            /^(?:\s|:[^\n]*\n)*(?:event:|data:)/.test(raw.slice(0, 2048))
              ? parseCompletionStream(raw, protocol, status)
              : fromEnvelope(JSON.parse(raw), protocol, status);
          if (parsed.usage.total !== null) {
            inputTokens += parsed.usage.total;
            inputReportedRequests++;
          }
          if (parsed.usage.output !== null) {
            outputTokens += parsed.usage.output;
            outputReportedRequests++;
          }
        } catch {
          // Unparseable usage stays unreported; accounting never changes the response.
        }
      };
    },
    snapshot(): AuditTokenUsage {
      return {
        modelRequests,
        inputReportedRequests,
        outputReportedRequests,
        inputTokens:
          (modelRequests === 0 || inputReportedRequests > 0) &&
          Number.isSafeInteger(inputTokens)
            ? inputTokens
            : null,
        outputTokens:
          (modelRequests === 0 || outputReportedRequests > 0) &&
          Number.isSafeInteger(outputTokens)
            ? outputTokens
            : null,
      };
    },
  };
}
