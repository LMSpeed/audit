const families = [
  'claude',
  'deepseek',
  'gemini',
  'glm',
  'gpt',
  'kimi',
  'minimax',
  'qwen',
] as const;
export function inferModelFamily(model: string) {
  const value = model.trim().toLowerCase();
  return (
    families.find((family) => value.includes(family)) ??
    (value.startsWith('o1') || value.startsWith('o3') || value.startsWith('o4')
      ? 'gpt'
      : value.split(/[/:_-]/)[0] || 'unknown')
  );
}
export function modelLooksCompatible(actual: string, expected: string) {
  return actual.trim().length > 0 && actual.trim() === expected.trim();
}
export function identityLooksCompatible(
  _text: string,
  _model: string
): boolean | null {
  return null;
}
export function expectedIdentityLabel(model: string) {
  return model;
}
