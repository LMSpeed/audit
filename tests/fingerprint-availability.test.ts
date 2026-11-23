import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLmspeedAudit } from '../src/compat/lmspeed.js';
import { runAudit } from '../src/index.js';
import { FeatureRelay } from './feature-relay.js';
import { tokenizerFixture } from './identity-fixtures.js';
import { writeNumericFixture } from './numeric-fixture.js';

let relay: FeatureRelay;
let baseUrl: string;
let directory: string;
beforeEach(async () => {
  relay = new FeatureRelay();
  baseUrl = await relay.start();
  directory = await mkdtemp(join(tmpdir(), 'audit-fingerprint-availability-'));
});
afterEach(async () => {
  await relay.close();
  await rm(directory, { recursive: true, force: true });
});
const options = { networkPolicy: 'local' as const };

describe('user skips fingerprint requests without matching reference data', () => {
  it('user normalizes both requested and stored numeric model IDs', async () => {
    // Given an internally consistent reference artifact whose IDs include provider namespaces and casing.
    const detectorSha256 = await writeNumericFixture(directory, undefined, [
      'vendor/A',
      'vendor/B',
    ]);
    relay.mode = 'numbers';
    // When a caller supplies a differently qualified form of the same ID.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'Other/A:tag' },
        apiKey: 'alias-contract-key',
        probes: ['numeric_fingerprint'],
        numericFingerprint: { dataDirectory: directory, detectorSha256 },
      },
      options
    );
    // Then normalization is symmetric and the original API route is retained.
    expect(report.usage.requests).toBe(3);
    expect(report.probes[0]?.observations.referenceMatch).toMatchObject({
      requestedModelId: 'Other/A:tag',
      normalizedModelId: 'a',
      referenceModelId: 'vendor/A',
      matchType: 'id',
    });
  });
  it('user does not spend tokens when one alias names multiple numeric reference groups', async () => {
    // Given two distinct, valid reference groups advertising the same full alias.
    const detectorSha256 = await writeNumericFixture(directory);
    const path = join(directory, 'unified_bank.json');
    const bank = JSON.parse(await readFile(path, 'utf8')) as {
      models: Array<{ id: string; display_name: string }>;
    };
    for (const model of bank.models)
      model.display_name = `${model.id}/shared-alias`;
    await writeFile(path, JSON.stringify(bank));
    // When the user requests that ambiguous alias.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'shared-alias' },
        apiKey: 'alias-contract-key',
        probes: ['numeric_fingerprint'],
        numericFingerprint: { dataDirectory: directory, detectorSha256 },
      },
      options
    );
    // Then neither group is guessed and the report distinguishes ambiguity from missing data.
    expect(report.probes[0]?.observations).toMatchObject({
      reason: 'numeric_model_reference_ambiguous',
      referenceCandidates: ['a', 'b'],
    });
    expect(report.coverage.skipped).toEqual(['numeric_fingerprint']);
    expect(report.usage.requests).toBe(0);
  });
  it('user skips both bundled fingerprints for a model absent from their reference banks', async () => {
    // Given a target with no numeric samples or tokenizer mapping in the shipped banks.
    // When the public SDK runs both fingerprint checks against a real HTTP endpoint.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'unlisted-model' },
        apiKey: 'availability-key',
        probes: ['numeric_fingerprint', 'tokenizer_fingerprint'],
      },
      options
    );
    // Then missing references skip collection entirely and cannot produce a finding or pass.
    expect(report.coverage.skipped).toEqual([
      'numeric_fingerprint',
      'tokenizer_fingerprint',
    ]);
    expect(report.probes.map((probe) => probe.observations.reason)).toEqual([
      'numeric_model_reference_missing',
      'tokenizer_model_reference_missing',
    ]);
    expect(report.probes.map((probe) => probe.verdict)).toEqual([
      'inconclusive',
      'inconclusive',
    ]);
    expect(report.usage.requests).toBe(0);
    expect(relay.requests).toBe(0);
    expect(report.findings).toEqual([]);
  });

  it('user skips explicitly selected fingerprints when no reference configuration exists', async () => {
    // Given bundled references are disabled and no custom references were supplied.
    // When all three fingerprint checks are explicitly selected.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'unlisted-model' },
        apiKey: 'availability-key',
        referenceData: 'disabled',
        probes: [
          'model_fingerprint',
          'numeric_fingerprint',
          'tokenizer_fingerprint',
        ],
      },
      options
    );
    // Then absent data is a skip, rather than an unsupported endpoint or a billed measurement.
    expect(report.coverage.skipped).toEqual([
      'model_fingerprint',
      'numeric_fingerprint',
      'tokenizer_fingerprint',
    ]);
    expect(report.coverage.unsupported).toEqual([]);
    expect(report.usage.requests).toBe(0);
    expect(relay.requests).toBe(0);
  });

  it('user skips a vendor model whose tokenizer has not been published', async () => {
    // Given a valid count bank that lists the model but has no corresponding tokenizer class.
    const bank = tokenizerFixture();
    bank.api_models = [];
    const unpublished = {
      ...bank,
      api_models: [{ pattern: '^test-model$', vendor: 'fixture', class: null }],
    };
    // When the SDK checks tokenizer availability.
    const report = await runAudit(
      {
        target: { baseUrl, modelId: 'test-model' },
        apiKey: 'availability-key',
        probes: ['tokenizer_fingerprint'],
        tokenizer: { bank: unpublished },
      },
      options
    );
    // Then an explicit unpublished mapping cannot fall back to alias guesses or spend tokens.
    expect(report.coverage.skipped).toEqual(['tokenizer_fingerprint']);
    expect(report.probes[0]?.observations.reason).toBe(
      'tokenizer_model_reference_missing'
    );
    expect(relay.requests).toBe(0);
  });

  it.each([
    ['provider/A:tag', 3, 'completed'],
    ['a-new-version', 0, 'skipped'],
  ] as const)(
    'user checks exact numeric reference coverage for %s',
    async (modelId, requests, execution) => {
      // Given a local bank with actual samples for a and b, but no other model versions.
      const detectorSha256 = await writeNumericFixture(directory);
      relay.mode = 'numbers';
      // When a provider-qualified ID or a different model version is checked.
      const report = await runAudit(
        {
          target: { baseUrl, modelId },
          apiKey: 'availability-key',
          probes: ['numeric_fingerprint'],
          numericFingerprint: { dataDirectory: directory, detectorSha256 },
        },
        options
      );
      // Then only the exact supported model spends requests; a similar name cannot borrow its baseline.
      expect(report.probes[0]?.execution).toBe(execution);
      expect(report.usage.requests).toBe(requests);
      expect(relay.requests).toBe(requests);
    }
  );

  it('user sees an explicit missing-model explanation in the website adapter', async () => {
    // Given a target with neither numeric data nor a tokenizer mapping.
    // When the independent SDK produces the website report.
    const output = await runLmspeedAudit(
      { baseUrl, modelId: 'unlisted-model', apiKey: 'availability-key' },
      { ...options, stepIds: ['numeric_fingerprint', 'tokenizer_fingerprint'] }
    );
    // Then both summaries explain the skip while retaining unknown severity and zero consumption.
    expect(output.steps.map((step) => step.summaryZh)).toEqual([
      '参考库没有当前模型的可用指纹数据，已跳过检测，未发送模型请求。',
      '参考库没有当前模型的可用指纹数据，已跳过检测，未发送模型请求。',
    ]);
    expect(output.steps.map((step) => step.severity)).toEqual([
      'unknown',
      'unknown',
    ]);
    expect(output.tokenUsage).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      modelRequests: 0,
    });
    expect(relay.requests).toBe(0);
  });
});
