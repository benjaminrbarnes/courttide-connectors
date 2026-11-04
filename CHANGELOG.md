# Changelog

## 0.1.1

- Preserve native ActiveNet timeout signals and CivicRec cancellation reasons.
- Classify CivicRec cancellation as a retryable HTTP failure and abort before body disposal.
- Keep raw transport failures separate from classifier errors, with a caller-owned error mapping seam.
- Report retryable body timeouts as inconclusive in local live checks.

## 0.1.0

- Add the read-only connector contract, shared runtime and synthetic conformance kit.
- Add anonymous ActiveNet and CivicRec platform connectors.
- Add a single-court CLI with offline fixtures and local recording.
- Expose the CivicRec hours parser through the testing entrypoint for synthetic parity checks.
- Preserve retryability when reporting a failed operation to its gate.
