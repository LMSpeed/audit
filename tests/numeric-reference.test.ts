import { describe, expect, it } from 'vitest';
import { matchNumericReference } from '../src/identity/numeric-reference.js';

// Ambiguous labels and normalization collisions are algorithm boundaries, not model-generation behavior.
describe('user resolves only explicitly declared numeric reference names', () => {
  it('user can find a hyphenated Claude reference using the dotted version', () => {
    // Given an independently supplied bank with an API-style Claude model ID.
    const models = [{ id: 'claude-sonnet-5-5', response_count: 12 }];
    // When the user selects the same model with a dotted version.
    const result = matchNumericReference(models, 'claude-sonnet-5.5');
    // Then the original reference ID is preserved for ranking comparisons.
    expect(result).toMatchObject({
      kind: 'matched',
      match: { referenceModelId: 'claude-sonnet-5-5', responseCount: 12 },
    });
  });
  it.each([
    ['claude-opus-5.5', 'claude-opus-5-6'],
    ['claude-opus-5.5', 'claude-opus-5-5-thinking'],
    ['claude-opus-5.5', 'claude-opus-5-5-20261119'],
    ['gpt-6.1-sol', 'gpt-6-1-sol'],
  ])('user keeps %s separate from %s', (referenceId, modelId) => {
    // Given a bank with one reference carrying samples.
    const models = [{ id: referenceId, response_count: 12 }];
    // When the requested ID differs beyond Claude's version separator.
    const result = matchNumericReference(models, modelId);
    // Then the check cannot borrow samples for a different or undeclared ID.
    expect(result).toEqual({ kind: 'missing' });
  });
  it('user sees ambiguity when both Claude version spellings name separate sampled groups', () => {
    // Given a bank where both spellings carry separate samples.
    const models = ['claude-opus-5.5', 'claude-opus-5-5'].map((id) => ({
      id,
      response_count: 12,
    }));
    // When the user selects that model.
    const result = matchNumericReference(models, 'claude-opus-5-5');
    // Then the conflicting samples are reported without choosing one group.
    expect(result).toEqual({
      kind: 'ambiguous',
      candidates: ['claude-opus-5.5', 'claude-opus-5-5'],
    });
  });
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
