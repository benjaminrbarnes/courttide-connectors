# Changelog

## 1.1.0

**UNRELEASED**

- Add optional HTTP admission to the runtime and CLI, with guarded fetch entry
  and fail-closed reservation and outcome reporting.
- Add optional process-local reuse of successful anonymous CivicRec bootstrap
  sessions, with scoped proofs, local expiry and separate job authority.

## 1.0.0

- Mark the existing read-only ActiveNet and CivicRec connectors as stable.
- Retain the contract, runtime, CLI and local pacing from 0.1.2.

## 0.1.2

- Use a 2.5-second default and 2-second minimum for local development pacing.
- Share CLI admission by site and back off after failed reads or supplied retry delays.
- Remove superseded rolling development ceilings without changing scheduled caller controls.

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
