# CivicRec connector

`@courttide/connectors/civicrec` reads anonymous, reported opening ranges. It
uses a caller-provided tenant configuration and the shared HTTP runtime. The
connector makes a catalog bootstrap request, then one hours request per date;
it accepts inclusive ranges of one or two dates. No metadata or booking action
is part of this connector.

The bootstrap's session key and cookie are secrets. They stay in memory and
never appear in a reading. By default, bootstrap is cached per connector,
including a failure. Keep that connector and runtime within one job's authority
lifetime; retaining them would also retain the job's gate and signal.

Version 1.1.1 adds allowlisted `ConnectorError.rejectionReason` diagnostics
for anonymous setup. They distinguish transport redirects, authentication
statuses, content-type guards, challenges and application errors, followed by
bootstrap envelope, chronology, attribute, JSON, anonymous checkout and cookie
validation rules. The shared transport diagnostics also apply to hours reads.
See the [contract's exact reason list](../../docs/CONTRACT.md#interfaces).
No response content, cookie value or source configuration is included. Reasons
identify the first failed rule and preserve its existing code, retry behavior
and gate outcome. Errors outside these rules may omit the diagnostic; missing
diagnostics do not identify a cause. Cookie domain, path, partitioning, prefix,
syntax, limits and expiration rules remain unchanged. Version 1.1.2 accepts
Secure partitioned (CHIPS) cookies, such as CDN bot-management cookies.

Cross-job session reuse requires version 1.1.0 or later; version 1.1.0 is
unreleased. The store is anonymous-only and process-local; it does not
coordinate sessions between processes.

To reuse a successful anonymous bootstrap across jobs in one process, create
`createSessionStore({ maxAgeMs })` and pass the store as `sessionStore` to each
job's `createConnectorRuntime`. Each job still creates its own runtime, gate and
signal. If the connector context supplies a signal, pass that same signal to
its runtime. Use `sessionAccount: "anonymous"` or omit it; member sessions are
not supported. The store keys the complete tenant configuration and transport
profile, not the job's selected-court list. It also keys the injected fetch
function's identity. For per-job wrappers around the same underlying transport,
pass the same `sessionTransportIdentity` object only when their transport
configuration is equivalent. Different transports must use different objects.

The required `maxAgeMs` is a local policy from 1 millisecond through one hour,
not a claim about the server's session lifetime. A cookie's earlier explicit
expiry also limits reuse. The store compares the original receipt time against
the process wall clock, so job clocks must agree with that clock. `maxEntries`
defaults to 16 and can be 1 through 64.
The store is process-local, retains only successful setup and coalesces a
concurrent setup for the same scope. Cancelling a waiting job does not cancel
the owner; cancelling the owner can fail its waiters. A later caller may try
again through its own admission. Use `runtime.invalidateSession()` for its
scope or `store.clear()` for all scopes. Both invalidate in-flight adoption;
they do not start another request.

Known expiry between dates can cause one newly admitted bootstrap before the
next date. A proof that expires while waiting for admission is rejected before
the request is sent. Blocks, rate limits and ordinary failures do not trigger
an authentication retry. With a valid session, each date uses one hours
request; a cold session also needs one bootstrap. These are implementation
call shapes, not measured provider-session lifetimes. Original setup provenance
and package-owned cookie proofs are retained without replaying an old HTTP
response. Follow the [session lifecycle contract](../../docs/CONTRACT.md#provider-setup-and-session-reuse).

A successful day reports `status: 200`, partial coverage and
`continuous_ranges` evidence. Only reported non-block ranges are candidates for
availability. The connector checks that both range arrays agree and that epoch
and local time agree, clips each eligible range at the configured local closing
time, and keeps the provider's source order. Explicit overlaps and duplicates
are retained. Storage and matching can reject those ranges. Time outside the
reported ranges is unknown.

`availableForRate: false` is hidden. Empty arrays are a recognized response,
so the range can be complete while the day remains unusable and unknown. Other
parser issues make the range incomplete; missing required fields or invalid
evidence fail the read. Reasons begin with `reported_ranges_only`, followed by
parser issues in their raised order, then `source_hidden_or_unavailable` when
hidden and `occupancy_unknown` when unusable. The full issue list is in the
[contract](../../docs/CONTRACT.md#shapes-and-reason-codes).

Every fixture in this repository is synthetic. The conformance matrix marks
these cases inapplicable:

- Taken intervals and whole-day closed or booked statuses: this endpoint reports
  positive ranges and has no such status.
- Unknown status: there is no status enumeration; invalid eligibility signals
  are tested directly.
- Wrong echoed facility ID: the response does not echo one, so identity mode is
  `none`.
- Missing or duplicate date rows: each date is a separate request.
- Instruction-like source label: this endpoint returns no court label; configured
  labels are not read or returned.
