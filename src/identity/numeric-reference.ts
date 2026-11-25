export type NumericReferenceModel = {
  id: string;
  display_name?: string;
  response_count: number;
};

export type NumericReferenceMatch = {
  requestedModelId: string;
  normalizedModelId: string;
  referenceModelId: string;
  referenceDisplayName: string;
  responseCount: number;
  matchType: 'id' | 'group_alias';
  groupMembers: string[];
};

const normalizeModelId = (value: string) =>
  value
    .trim()
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/:.*$/, '')
    .replace(
      /^(claude-(?:haiku|sonnet|opus|fable|mythos)-\d+)-(\d+)$/,
      '$1.$2'
    );

function groupMembers(model: NumericReferenceModel) {
  const id = model.id.trim().toLowerCase();
  const normalized = normalizeModelId(id);
  const display = model.display_name?.trim().toLowerCase();
  if (!display?.startsWith(`${id}/`)) return [normalized];
  const prefix = normalized.match(/^([a-z][a-z0-9._-]*?-)\d/)?.[1];
  // Upstream uses explicit combined labels such as gpt-6-astra/6.1-sol.
  const aliases = display
    .slice(id.length + 1)
    .split('/')
    .flatMap((name) => {
      const value = name.trim();
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(value)) return [];
      if (/^\d/.test(value)) return prefix ? [`${prefix}${value}`] : [];
      return [value];
    });
  return [...new Set([normalized, ...aliases.map(normalizeModelId)])];
}

export function matchNumericReference(
  models: NumericReferenceModel[],
  requestedModelId: string
):
  | { kind: 'missing' }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'matched'; match: NumericReferenceMatch } {
  const normalizedModelId = normalizeModelId(requestedModelId);
  const available = models.filter((model) => model.response_count > 0);
  const exact = available.filter(
    (model) => normalizeModelId(model.id) === normalizedModelId
  );
  const candidates = exact.length
    ? exact
    : available.filter((model) =>
        groupMembers(model).includes(normalizedModelId)
      );
  if (!candidates.length) return { kind: 'missing' };
  if (candidates.length > 1)
    return {
      kind: 'ambiguous',
      candidates: candidates.map((model) => model.id),
    };
  const model = candidates[0]!;
  return {
    kind: 'matched',
    match: {
      requestedModelId,
      normalizedModelId,
      referenceModelId: model.id,
      referenceDisplayName: model.display_name ?? model.id,
      responseCount: model.response_count,
      matchType: exact.length ? 'id' : 'group_alias',
      groupMembers: groupMembers(model),
    },
  };
}
