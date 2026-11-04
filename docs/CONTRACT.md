# Connector contract, version 1

A platform is booking software used by operators. A tenant is one operator's
site, with parks and courts. Connectors implement a platform once; callers pass
their own tenant configuration at runtime. Keep real configurations, court
details and recorded responses outside this repository.

A connector reads one court for an inclusive range of local dates. It returns
what the platform reported, the limits of that observation and attribution. It
does not schedule, retry, book or infer that unreported time is unavailable.

## Rules

- Failed, hidden, missing, unread or partial data never becomes a booked or open
  conclusion. A visible partial full calendar is unusable but may retain the
  provider's explicit interval flags as source evidence. Hidden, unknown and
  invalid days carry no intervals. Time outside reported intervals is unknown.
- Reads use only the public page's read calls through an allowlist of origins,
  methods, path grammar and headers. Booking, cart, hold, checkout and account
  calls are outside the contract.
- Every request goes through the injected `HttpClient` and `Gate`. A connector
  does not call `fetch` directly or add headers outside its transport profile.
- Connectors do not retry. They throw `ConnectorError` with retry information;
  the caller decides what happens next. Errors thrown by a gate pass through.
- Public platforms require no credentials. Outputs contain no cookies, session
  keys, member tokens or personal details. Public fixtures are synthetic.
- Court keys stay stable. Parser versions and reason codes are persisted by
  callers and change only deliberately. Identical responses and injected clocks
  must produce byte-identical requests and output.
- Every reading carries the attribution below. Preserve it when displaying data.

## Interfaces

The package exports the TypeScript interfaces, Zod schemas, contextual reading
validator and `CONTRACT_VERSION`, which is `"1"` throughout the 0.x releases.
Relative dates are `YYYY-MM-DD` in the tenant's IANA time zone; instants are
UTC ISO 8601 strings.

`Platform` has a lowercase kebab-case `id`; parser `id`, `version` and
`signature`; parameter schemas; a `TransportProfile`; `capabilities(tenant)`;
and `createConnector(context)`. Creating a connector validates an allowed set
of one to 256 unique court keys. The context provides the configuration, an
optional allowed subset, an HTTP client, `now()` and an optional abort signal.
Every clock read comes from `now()`.

`Capabilities` states `auth: "none"`, the read shape, maximum days per read,
`leaseScope`, estimated request counts, minimum gap of at least 10 seconds,
identity mode and `bookingWrites: false`. `readCourt` accepts one allowed key
and an inclusive date range. Invalid or disallowed keys throw
`identity_mismatch` before a request or gate call; unsupported ranges throw
`unsupported_time`. Where identity mode is `label_check`, `verifyCourt`
returns the trimmed platform label and key, and throws `identity_mismatch`
when an echoed key differs. Comparing that label with configuration belongs to
the caller.

`TenantConfig` contains `schemaVersion: "1"`, platform and tenant keys, time
zone, origin, platform parameters and parks. Each park has a key, name, optional
CourtTide slug and `publicTimes`, and courts. Each court has a stable key,
label, optional platform label and retirement date, and platform parameters.
`publicTimes` omitted means unchecked, `false` means no published open times,
and `true` means they have been verified. Configuration does not enable reads.
A moved court gets a new key; retain the old entry with its retirement date.

`CourtReading` contains platform, tenant and court keys; inclusive start and
end dates; the platform-specific `complete` result; `observedAt` from the
injected clock after the last response; the exact token-free source URL; days;
`sanitized` JSON of at most 1 MiB; parser identity; and attribution. Its source
URL follows the platform's documented template and never includes a session key,
cookie or token. Each platform documents what makes its reading complete and
the shape and key order of its sanitized output.

`DayReading` has date, optional per-response `observedAt`, the platform status,
visibility, coverage, `usable`, ordered reason codes and intervals. Each
interval has a UTC start, end and `available` boolean. Starts belong to the
day's local date; ends may reach the following local midnight. Intervals are
positive and non-overlapping; touching is allowed. A usable
`continuous_ranges` day has the evidence below. A `full_calendar` day never
has that evidence.

`Evidence` has `kind: "continuous_ranges"`, `scope: "reported_ranges_only"`,
start increment of 5 or 15 minutes, an anchor of `local_midnight` or
`range_start`, minimum occupied minutes, duration step minutes and an optional
maximum occupied duration.

`ConnectorError` has name `ConnectorError`, a code, `retryable` and nullable
`retryAfterMs`. Codes are `auth_required`, `http_error`, `rate_limited`,
`access_blocked`, `schema_changed`, `identity_mismatch`,
`date_coverage_incomplete`, `invalid_interval` and `unsupported_time`.
`GateDeferred` has name `GateDeferred`, an `until` instant and reason `hold`,
`pacing` or `budget`.

`ATTRIBUTION` is:

```json
{
  "text": "Read with courttide-connectors by CourtTide",
  "url": "https://courttide.com"
}
```

When configuration has a CourtTide slug, the reading also has `parkUrl` pointing
to that park's CourtTide page. `readingSchema` checks attribution, shape,
time-zone boundaries and marked-secret echoes using the caller's context;
`CourtReadingSchema` checks the context-free rules. The configuration schema
is available as `TenantConfigSchema` and as
`@courttide/connectors/schema/tenant.schema.json`. The generated JSON Schema
cannot resolve a time-zone name against the runtime's IANA database, so use
the Zod schema for that check too.

## Network seam

`Gate.acquire` receives the court, purpose (`calendar`, `identity`, `bootstrap`
or `metadata`), method and URL. It returns a ticket or throws. A failed acquire
is never followed by release. `Gate.release` receives that ticket once and the
final outcome: `ok`, optional status, an error code when not ok, and optional
retry delay.

The injected `HttpClient.request` receives court, purpose, GET or read-only
POST, URL, allowed headers, optional string body and expected JSON or HTML. It
returns status, headers, text and requested/received instants. A request rejected
by the allowlist makes no gate calls; rejected bodies are cancelled.

Discovery and live checks share one gate per connector and upstream target
across courts, workers and iterations. Requests are at least 10 seconds apart,
with ceilings of 6 per rolling minute, 20 per rolling 10 minutes and 30 per
rolling hour. These are limits, not quotas. Separate processes coordinate through
the caller's existing admission, gate, lease, priority and backoff.

`leaseScope: "per_read"` releases after the whole read or identity check,
including parsing, and reports its final outcome. `"per_request"` releases
after each response is classified, including a platform's payload-level
classification hook. This distinction ensures parser-time access blocks reach
the appropriate gate.

Transport profiles declare retry-after parsing, success statuses, redirect
headers, body-read policy, content-length checks, accepted content types,
challenge rules, allowed headers, method-specific URL grammar, cookie-jar
policy and an optional classifier. Header rules can require an exact value,
limit length or forbid a header for particular purposes. URL grammar validates
method, segment count, identifiers, dates and query, rather than only a prefix.

Existing profiles retain their platform behavior:

- ActiveNet uses strict IMF Retry-After parsing, any 2xx success, no redirect
  headers, JSON content type and no cookie jar. Its one request header is
  `accept: application/json`.
- CivicRec uses lenient Retry-After parsing, only status 200 as success,
  `location` and `refresh` as block signals, content-length checks, JSON or
  bootstrap HTML and a strict cookie jar. Bootstrap sends neither cookie nor
  `x-requested-with`; later requests allow those headers and require `accept`.
  When present, `x-requested-with` is exactly `XMLHttpRequest`.
  Header values are printable ASCII, cookies are capped at 16 KiB and other
  header values at 256 characters. The jar limits domains and paths, rejects
  `Partitioned`, enforces `__Secure-` and `__Host-` rules, gives Max-Age
  precedence over Expires, and accepts one to 16 rows up to 16 KiB.
- The challenge detector treats a challenge title, challenge form or challenge
  platform path as a block, except the profile's explicitly listed passive
  asset. A block is never bypassed.

Strict Retry-After accepts digit seconds with leading zeros removed; more than
13 digits or a delay exceeding the supported date range gives no value. It also
accepts one IMF-fixdate GMT that round-trips and is no more than 64 characters,
clamping a past date to zero. Lenient parsing accepts up to eight digit seconds
or a parseable date of up to 80 characters; a negative or non-finite delay is
not retryable. Both use the injected clock.

Classify requests in this order: fetch failure, redirect, 401/403, 429, 5xx,
other statuses, content length, content type, bounded UTF-8 body, HTML in place
of JSON, challenge, JSON parsing, then the platform classifier. Fetch and stream
errors are `http_error`, retryable only when timeout-like. A redirect or 401/403
is `access_blocked`; a 429 is retryable only when Retry-After parses; a 5xx is
a retryable `http_error`. A nonnumeric or oversized checked content length is
`schema_changed`; an uncompressed mismatch is a non-retryable `http_error`.
Wrong content type, HTML instead of JSON or a challenge is `access_blocked`;
an absent, malformed, oversized or invalid UTF-8 body is `schema_changed`. The
15-second timeout starts after acquire and covers headers and body. New profiles
default to strict Retry-After, any 2xx, no redirect headers, body reads only on
success and JSON content type.

## Shapes and reason codes

`full_calendar` lists open and taken slots, so a usable complete day may have
explicit `available: false` intervals. A visible partial full-calendar day is
unusable; any retained interval flags are source evidence, not an availability
result. `continuous_ranges` reports open ranges only: a usable day has partial
coverage, reported-only evidence and only `available: true` intervals; it never
has `available: false`. Absence is not a booking. Offered fixed-duration
starts and reservation-only calendars are not v1 shapes; a reservation-only
source is unusable with `reported_reservations_only`.

ActiveNet's documented codes are `source_hidden_or_unavailable`,
`occupancy_unknown`, `source_schedule_closed`, `source_fully_booked`,
`source_closes_at_midnight`, `unknown_source_status`,
`unsupported_check_mode`, `duplicate_source_date`, `date_out_of_range`,
`date_coverage_incomplete` and `range_incomplete`.
After the parser's day reason, append `duplicate_source_date` when applicable,
then `date_out_of_range`, then `date_coverage_incomplete`, and finally
`range_incomplete`. A hidden day starts with `source_hidden_or_unavailable`
followed by `occupancy_unknown`.

CivicRec places `reported_ranges_only` first, followed by parser issues in
their raised order, then `source_hidden_or_unavailable` when hidden, then
`occupancy_unknown` when unusable. Its issue codes are
`invalid_request_context`, `invalid_payload`, `hours_missing_or_invalid`,
`display_hours_missing_or_invalid`, `empty_hours`, `empty_display_hours`,
`range_limit_exceeded`, `invalid_range_shape`, `nonpositive_range`,
`unsupported_cross_date_range`, `invalid_epoch`, `invalid_local_time`,
`epoch_local_mismatch`, `date_mismatch`, `rate_mismatch`,
`display_hours_conflict`, `invalid_signal` and `text_limit_exceeded`.
`reported_starts_only` and `reported_reservations_only` are reserved for later
shapes. New platform codes are documented by that platform and retain meaning.

## Conformance

`@courttide/connectors/testing` exports `runConformance`, a scripted fake
fetch, recording gate, frozen clock and the case matrix. The runner takes a
platform, fixture directory and an injected runtime harness factory. The
factory receives the fake fetch, recording gate, tenant and clock, and returns
an `HttpClient` plus an operation wrapper. The wrapper lets a runtime release a
per-read ticket after parsing. The kit does not itself implement transport.

Each case directory contains `meta.json` with a source, case names, `clockNow`,
configuration path, court and date range. It has `responses.json`,
`requests.json`, `gate.json`, and exactly one of `expected.json` or
`error.json`. Optional metadata declares allowed courts, marked synthetic
secrets, a gate deferral, an identity operation or an expected reflected-secret
failure. Public metadata has `"source": "synthetic"`; use the example config
under `examples/tenants/` and keys from 900001 through 900099.

The runner compares request URLs, headers, bodies and fetch options in order;
gate acquires, releases and outcomes; and output or error fields. It validates
the reading and checks sanitized output against marked secrets. A reflected
session key or cookie on a bootstrapped platform must fail with
`schema_changed`. A rejected request has no gate calls; a deferred acquire has
no release; a parser-time block reaches the applicable release.

The repository data check scans tracked text and the packed package for
non-example identifiers, tenant and catalog paths, slugs, unmarked hashes,
non-synthetic fixture metadata and private references. It does not replace a
review of the actual diff and packaged contents. Synthetic JSON objects that
include a real-shaped `detailsTextSha256` mark it with a sibling
`detailsTextSha256Synthetic: true`.

The matrix covers open, explicit taken, gap and touching intervals; closed,
booked, hidden and unknown days; identity and date mismatches; valid DST,
nonexistent and ambiguous local times; midnight and cross-day intervals;
invalid allowed courts and ranges; rate limits, server failures, timeouts,
redirects and access blocks; HTML, challenges and passive assets; oversized,
malformed or missing bodies; application errors; inert instruction-like labels;
and bootstrap, cookie and session failures. Every case is exercised or has an
explicit reason it cannot occur, also documented by the platform. Hidden or
unknown days and missing, duplicate or out-of-range dates return days and
reason codes when the platform specifies them; malformed or invalid evidence
throws as specified by the platform.

## Versioning and credit

A contract change is a major version, a new platform is a minor version, and a
parser fix is a patch that also bumps that parser's version. Callers reject an
unknown contract major. CLI output and readings carry
“Read with courttide-connectors by CourtTide · https://courttide.com”.
