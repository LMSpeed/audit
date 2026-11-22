export function classifyChannel(
  headers: Record<string, string>,
  _body: string
) {
  const names = Object.keys(headers).map((name) => name.toLowerCase());
  const candidates: string[] = [];
  const evidence: string[] = [];
  for (const name of names) {
    const channel = name.startsWith('cf-aig-')
      ? 'cloudflare-ai-gateway'
      : name.startsWith('x-amzn-bedrock-')
        ? 'aws-bedrock'
        : name.startsWith('anthropic-ratelimit-')
          ? 'anthropic-api'
          : null;
    if (channel) {
      candidates.push(channel);
      evidence.push(name);
    }
  }
  const distinct = [...new Set(candidates)];
  return {
    channel:
      distinct.length === 1
        ? distinct[0]!
        : distinct.length
          ? 'ambiguous'
          : 'unknown',
    confidence: distinct.length === 1 ? 0.5 : 0,
    evidence,
  };
}
