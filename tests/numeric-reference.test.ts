import { describe, expect, it } from 'vitest';
import { matchNumericReference } from '../src/identity/numeric-reference.js';

// Ambiguous labels and normalization collisions are algorithm boundaries, not model-generation behavior.
describe('user resolves only explicitly declared numeric reference names', () => {
  it('user does not mistake a free-form description for a reference alias', () => {
    // Given a descriptive label mentioning another model without an anchored combined-group declaration.
    const models = [
      {
        id: 'a',
        display_name: 'a compared with gpt-6.1-sol',
        response_count: 8,
      },
    ];
    // When that mentioned model is requested.
    const result = matchNumericReference(models, 'gpt-6.1-sol');
    // Then incidental text cannot supply reference coverage.
    expect(result).toEqual({ kind: 'missing' });
  });
  it('user does not count an alias with zero reference samples as available data', () => {
    // Given an explicit group label with no collected samples.
    const models = [
      {
        id: 'gpt-6-astra',
        display_name: 'gpt-6-astra/6.1-sol',
        response_count: 0,
      },
    ];
    // When a group member is requested.
    const result = matchNumericReference(models, 'gpt-6.1-sol');
    // Then an advertised name alone does not enable paid sampling.
    expect(result).toEqual({ kind: 'missing' });
  });
  it('user sees namespace collisions as ambiguous instead of choosing the first reference', () => {
    // Given distinct stored references collapsing to the same unqualified ID.
    const models = ['vendor-one/a', 'vendor-two/a'].map((id) => ({
      id,
      response_count: 8,
    }));
    // When the user supplies that unqualified name.
    const result = matchNumericReference(models, 'A');
    // Then both possibilities remain visible and no arbitrary reference is selected.
    expect(result).toEqual({
      kind: 'ambiguous',
      candidates: ['vendor-one/a', 'vendor-two/a'],
    });
  });
  it('user keeps a direct model ID authoritative over another groups alias', () => {
    // Given a direct model ID and a distinct group that happens to advertise the same alias.
    const models = [
      { id: 'shared', response_count: 8 },
      { id: 'other', display_name: 'other/shared', response_count: 8 },
    ];
    // When the exact model name is requested.
    const result = matchNumericReference(models, 'shared');
    // Then the direct reference is used without being redirected by a weaker label.
    expect(result).toMatchObject({
      kind: 'matched',
      match: { referenceModelId: 'shared', matchType: 'id' },
    });
  });
  it('user cannot expand a version shorthand without a declared model-family prefix', () => {
    // Given a shorthand label whose primary name does not identify its family prefix.
    const models = [{ id: 'a', display_name: 'a/6.1-sol', response_count: 8 }];
    // When a full GPT model ID is requested.
    const result = matchNumericReference(models, 'gpt-6.1-sol');
    // Then the family is not guessed from a version suffix.
    expect(result).toEqual({ kind: 'missing' });
  });
});
