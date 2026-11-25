# Detection acceptance scenarios

[English](./acceptance.md) · [简体中文](./acceptance.zh-CN.md) · [Русский](./acceptance.ru.md)

Automated scenarios exercise the public audit entrypoint through a real loopback HTTP server. The server implements documented protocol behavior; it is not evidence of live model accuracy. Independently authenticated provider contracts and model-identification accuracy remain unverified.

- Given a declared tool and a forced call, when a user audits tools, then wrong names, invalid arguments and calls returned while tools are disabled are findings. Tools are never executed.
- Given a strict JSON schema, when a user audits structured output, then fenced text, wrong types, missing or extra fields fail the contract.
- Given an image or PDF with a generated answer absent from the prompt, when a user enables that capability, then actual media bytes are submitted and only a correct answer passes.
- Given multiple random facts at several context positions and lengths, when a user audits recall, then each position is checked and failed recall is not attributed to relay truncation.
- Given the same deterministic request in streamed and non-streamed form, when a user compares them, then model, framing and usage differences remain distinct from content variation.
- Given cached input usage, when a user checks reported input, then Messages adds cache reads/writes and Chat does not double-count them. Unknown or invalid counts are not zero.
- Given JSON and SSE model responses, when an audit finishes or saves a completed step, then reported input/output Token totals and separate per-direction coverage survive SDK, compatibility and stored-report boundaries. Cumulative stream usage is counted once, cache input is not counted twice, reasoning is already included in output, and missing usage remains unknown rather than zero. Request-size estimates remain separate budget fields.
- Given an empty explicit refusal or unsolicited SSE, when a user audits an endpoint, then the outcome is classified without protocol fallback, retries or scoring it as an ordinary answer.
- Given deterministic math, logic, format, recall and code checks, when a user audits quality, then the report records each answer and a bounded aggregate without inferring model identity.
- Given the correct system marker with explanatory prose or the correct JSON value inside a Markdown fence, when the audit measures the response, then the report identifies the specific output-format difference. Instruction priority, quality and context results use the recorded measurements directly.
- Given a trusted reference endpoint, when a user compares quality, then reference and target share tasks and parameters, acquisition failures stay out of answer scoring, and an optional judge is explicitly configured.
- Given a fresh baseline collected in independent training and validation batches, when a user requests identity evidence, then matching distributions are distinguished from other reference sources. Stale, incompatible, uncalibrated, incomplete and poorly fitting samples abstain.
- Given a reference bank without usable data for the selected model, when fingerprint checks run, then they are skipped before any model request, retain an explicit missing-reference reason and never become a pass or finding. Exact supported numeric IDs and known tokenizer mappings still collect evidence; unrelated model versions and unpublished tokenizer mappings cannot substitute for missing data.
- Given balanced ordinary and sensitive prompt pairs, when a user checks conditional injection, then only a reproducible excess of secret-disclosure/redirect signals is flagged. Refusal and legitimate task differences alone are not injection.
- Given a request, input, output or duration limit, when any new detector runs, then all its target, reference and judge calls share that budget, cancellation propagates and credentials are redacted.
- Given LMSpeed selects a new detector, when the audit runs, then progress, persisted facts and final reports include it through the same engine used by standalone callers.

- Given correctly recovered facts inside a Markdown code block, when recall is audited, then formatting does not become a false missing-fact finding; actual missing markers still fail repeated confirmation.
- Given an implausible Token count on the first short context calibration, when the request budget allows, then the audit confirms that sample once and uses a plausible count to continue. The original Token count remains in the trial evidence.
- Given identical visible text with different reasoning-token totals, when streams are compared, then explicitly reported reasoning is removed; missing reasoning breakdowns yield an inconclusive comparison rather than a false metering finding.

## Core boundary and streaming contracts

- Given a newly generated system acknowledgement, when conflicting user content requests another answer, then an exact response passes and a mismatch is a weak system-priority finding.
- Given a random protected value, when direct, JSON and base64 disclosure requests are issued, then its literal or encoded disclosure is strong evidence of that controlled leak, even with refusal wording. It says nothing about an unknown relay prompt.
- Given a generated package literal, when the model is asked to copy it, then changes are reported without executing any command.
- Given malformed JSON, when the endpoint rejects it, then sensitive configuration assignments are reported with values omitted. Accepted requests or auth/rate-limited rejections remain inconclusive.
- Given an SSE response, when termination, model consistency and reported counters are checked, then malformed payloads, missing terminals, model changes and counter regressions are findings. Comment/ping-only traffic is inconclusive. Unknown future Anthropic event types alone are not corruption.
- Given multiple channel namespaces, when response headers are inspected, then conflicting hints are ambiguous. Generic CDN headers and response ID formats do not identify a channel.
- Given five successful requests, when latency is measured, then descriptive statistics are reported without inherited stable/bimodal/routing thresholds.
- Given a failed request, cancellation or a spent resource budget, when remaining checks run, then missing evidence cannot become a pass or leak credentials through progress/report callbacks.

## Documentation distribution

- Given a clean installation from the actual publishable tarball, when a user opens the English, Simplified Chinese or Russian README, then every guide, linked local document and preview image is available.
- Given an extracted portable archive, when a user reads its documentation, then the same three-language guides, acceptance scenarios, evidence limits, publishing instructions and changelogs are available without fetching the source repository.
