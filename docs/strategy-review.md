# Detection strategy and evidence limits

This document summarizes the detection boundaries, statistical controls, and evidence limits of `@lmspeed/audit` (`0.3.0`). Supported wire contracts follow the public WHATWG Server-Sent Events, OpenAI Chat Completions and Responses APIs, and Anthropic Messages API specifications.

Capability checks exercise actual tool envelopes, negative tool controls, strict schemas and generated media. No tools execute. Context checks use random facts and repeated confirmation of misses. Conditional injection compares balanced ordinary/sensitive controls; a refusal alone is not a finding.

Quality checks measure a small workload. Paired comparisons distinguish acquisition failures from answers; optional judge opinions are auxiliary. Behavioral distributions require fresh compatible calibration, independently collected holdouts, external negative sources, absolute fit and separation. Inadequate evidence requires abstention.

MIT tokenizer evidence is supporting evidence only. The separately configured offline numeric scorer ranks candidates within a closed set; it does not authenticate an unlisted model. No third-party model reference data is distributed here.

Self-identification, response IDs, header hints and latency do not identify the actual upstream model. Error responses, malformed streams and random challenge failures report observed contracts, not the cause of a failure. A clean report covers only the selected workload and is not a safety certificate.

The HTTP fakes are exercised through real sockets, including failure outcomes. They have not been independently contract-validated against authenticated first-party providers. Automated tests verify these implementation contracts, not measured model-identification accuracy.
