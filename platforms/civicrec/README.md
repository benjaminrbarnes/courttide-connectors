# CivicRec connector

`@courttide/connectors/civicrec` reads anonymous, reported opening ranges. It
uses a caller-provided tenant configuration and the shared HTTP runtime. The
connector makes a catalog bootstrap request, then one hours request per date;
it accepts inclusive ranges of one or two dates. No metadata or booking action
is part of this connector.

The bootstrap's session key and cookie are secrets. They stay in memory, bind to
the runtime instance and never appear in a reading. Bootstrap is cached per
connector, including a failure; a block or expired session does not trigger a
retry or rebootstrap. Keep the connector and runtime together for session reuse.

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
