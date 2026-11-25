# Bundled reference data

`@lmspeed/audit` owns reference packaging, default selection, integrity checks and expiry. Host applications only call its SDK; no website bootstrap, data CDN or runtime updater is required. npm, GitHub Packages and portable archives all carry the same `assets/references` snapshot.

The initial snapshot derives from MIT-licensed Ikaleio/lm-detector commit `70159b7536a2ceb55c478c8c9472da81d3627e59`. The detector and tokenizer bank retain their original bytes. Numeric bank metadata retains the original model identifiers, display names, families, sample counts and build date; training arrays are not required by offline scoring and are omitted. This snapshot does not establish independent model-identification accuracy.

Every asset has a SHA-256 and size in `manifest.json`. Numeric data expires 30 days after its original build date. The fixed tokenizer archive expires after 90 days: tokenizer counts are tied to immutable tokenizer artifacts rather than changing model behavior. Explicit operator configurations retain their existing default 30-day policy and can select a stricter limit. Synchronization never resets either source date. An expired snapshot abstains before model requests and records the exact reference version; update and release data rather than extending dates to suppress expiry.

## Maintainer update

1. Review the source revision, data changes, rights and compatibility. Edit `references.source.json` with the exact commit and Git blob hashes. This source file is the only network input and is never read by an audit request.
2. Run `pnpm references:sync`. Downloads are HTTPS-only from the pinned repository commit, have a 60-second timeout and a 20 MB per-file cap. Git blob hashes are checked before transforming metadata; staged SHA-256 checks, bank validation and actual offline SDK loading must pass before replacing the snapshot. Download failures leave the previous snapshot untouched.
3. Review the resulting manifest, original dates and binary diff. Run `pnpm check`, `pnpm release:prepare`, and `pnpm release:smoke`. Existing CI performs the same package and portable checks. All required data and notices must survive installation outside this repository.
4. Publish a new immutable package version through the existing release workflow. Do not change data inside an already published version. Consumers upgrade `@lmspeed/audit` to select a new snapshot; they do not depend on a third-party `latest` URL.

## Caller controls

Numeric and tokenizer checks participate in the default plan; the connectivity profile stays limited to catalog and stream checks. Explicit probe selections are preserved. Set `referenceData: 'disabled'` in SDK input or CLI config JSON to omit bundled checks from an implicit plan. Explicit custom numeric or tokenizer configurations always take precedence and work with that opt-out.

Missing, incompatible, corrupted and expired assets produce per-probe inconclusive results. Other probes continue. Numeric rankings and tokenizer equality remain supporting evidence and never authenticate a model. Distribution verification requires an independently collected and calibrated baseline; this package does not manufacture one from its audit target.

Before collecting fingerprint responses, the package also checks coverage for the selected model. Numeric screening requires a matching model ID with nonzero reference samples. Provider prefixes and `:tag` suffixes are ignored, and Claude's hyphenated and dotted spellings for the same major and minor version are equivalent for reference lookup. The request retains the supplied model ID. Tokenizer checks require an existing class mapping. Missing configurations and missing model data appear in `coverage.skipped`, with inconclusive verdicts, explicit reasons and no model requests or Token consumption.
