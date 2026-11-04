# Response shapes

Use placeholders such as `{org}` and `{id}` in public examples. A connector
reports only what a source states; a missing, hidden, failed or partial read
never becomes a booked inference. See the [contract](CONTRACT.md) for exact
schema and reason rules.

## Full calendar with day statuses

An endpoint can return one date range with day statuses and explicit intervals.
ActiveNet uses `full_calendar`: recognized slot rows retain their stated open or
taken flags; whole-day closed or booked statuses can be complete; hidden and
unknown statuses are unusable. Preserve local time zones, the midnight sentinel,
check modes and source coverage. Reject ambiguous or nonexistent wall times.
An incomplete visible day can retain explicit source flags as evidence but is
not usable for availability.

## Reported opening ranges

A source can report positive ranges without saying anything about other time.
CivicRec maps this to `continuous_ranges` with partial coverage. Its anonymous
catalog bootstrap supplies a session value and scoped cookie. Its hours and
display arrays must agree, and epoch and local times must agree. Preserve
explicit source range order, including overlaps and duplicates; downstream
storage or matching may reject those ranges. Unknown or hidden days are never
usable. A session key is a secret and must not enter output or logs.

## Other shapes

- An offered-start page lists discrete start times, often for a fixed duration.
  The future `offered_starts` shape must keep the starts discrete rather than
  filling gaps. It is not a v1 `continuous_ranges` mapping.
- A reservations-only page lists taken blocks without stating open time. It has
  no v1 open-time mapping; use `reported_reservations_only` and keep it unusable.
- A single-page app may use JSON, GraphQL or a read-only search POST. Observe
  the public page's actual request, session and pagination behavior; declare an
  exact method and path grammar. Do not turn a login or booking action into a
  connector call.
- A challenge page, form or block is `access_blocked`. A documented passive
  asset may be allowlisted by a transport profile, but a challenge is never
  bypassed.
