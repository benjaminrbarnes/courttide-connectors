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
  does not call `fetch` directly or explicitly add or forward headers outside
  its transport profile. The native HTTP stack may add its own default headers;
  the connector and runtime do not suppress or spoof them.
- Connectors do not retry. They throw `ConnectorError` with retry information;
  the caller decides what happens next. Gate acquisition errors pass through.
  A per-request release failure is sanitized; a per-read release failure passes
  through to its caller.
- Public platforms require no credentials. Outputs contain no cookies, session
  keys, member tokens or personal details. Public fixtures are synthetic.
- Court keys stay stable. Parser versions and reason codes are persisted by
  callers and change only deliberately. Identical responses and injected clocks
  must produce byte-identical requests and output.
- Every reading carries the attribution below. Preserve it when displaying data.

## Interfaces

The package exports the TypeScript interfaces, Zod schemas, contextual reading
validator and `CONTRACT_VERSION`, which is `"1"`.
Relative dates are `YYYY-MM-DD` in the tenant's IANA time zone; instants are
UTC ISO 8601 strings.

`Platform` has a lowercase kebab-case `id`; parser `id`, `version` and
`signature`; parameter schemas; a `TransportProfile`; `capabilities(tenant)`;
and `createConnector(context)`. Creating a connector validates an allowed set
of one to 256 unique court keys. The context provides the configuration, an
optional allowed subset, an HTTP client, `now()` and an optional abort signal.
Every clock read comes from `now()`.

`Capabilities` states `auth: "none"`, the read shape, maximum days per read,
`leaseScope`, estimated request counts, minimum gap of at least 2 seconds,
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
positive. Full-calendar intervals do not overlap; touching is allowed. Partial
reported ranges may preserve explicit overlaps or duplicates in source order;
storage and matching may reject those ranges.
A usable
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
Version 1.1.1 adds optional readonly `rejectionReason`, a bounded diagnostic
identifier separate from the code and day reason codes. The constructor is
`new ConnectorError(code, retryable = false, retryAfterMs = null, rejectionReason?)`.
It preserves the existing message, code and retry semantics, and drops an
unrecognized diagnostic at runtime. The package exports the frozen
`CONNECTOR_REJECTION_REASONS` allowlist, its `ConnectorRejectionReason` string
union and `isConnectorRejectionReason(value: unknown)` type guard. Runtime
error normalization preserves only an allowlisted reason. Callers should use
that guard before recording reasons from untrusted error-like values.

Reasons identify the first existing failed rule, without response values,
cookie names, paths, domains, timestamps or source text:

| Reason                         | Existing rejection rule                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------- |
| `transport_redirect`           | Redirected response or redirect status                                                |
| `transport_redirect_header`    | Configured redirect header present                                                    |
| `transport_auth_status`        | HTTP 401 or 403                                                                       |
| `transport_content_type`       | Missing or disallowed response content type                                           |
| `transport_challenge`          | Active challenge detected                                                             |
| `transport_json_html`          | HTML-shaped body where JSON was requested                                             |
| `transport_application_error`  | CivicRec application error matches the existing session-rejection pattern             |
| `bootstrap_content_type`       | CivicRec requires HTML after runtime response classification                          |
| `bootstrap_response_invalid`   | Invalid injected-client bootstrap response envelope                                   |
| `bootstrap_chronology`         | Invalid or reversed injected-client bootstrap timestamps                              |
| `bootstrap_context_invalid`    | Invalid bootstrap receipt instant or catalog URL context                              |
| `bootstrap_attributes_invalid` | Invalid or missing bootstrap attributes, including HTML syntax and attribute entities |
| `bootstrap_json_invalid`       | Bootstrap attribute is not JSON                                                       |
| `bootstrap_checkout_invalid`   | Invalid anonymous checkout shape, key or base path                                    |
| `cookie_received_at`           | Invalid cookie receipt instant                                                        |
| `cookie_missing`               | No cookie rows                                                                        |
| `cookie_rows_limit`            | Cookie row limit exceeded                                                             |
| `cookie_bytes_limit`           | Cookie byte limit exceeded                                                            |
| `cookie_pair_invalid`          | Invalid name/value pair delimiter                                                     |
| `cookie_name_invalid`          | Invalid cookie name syntax                                                            |
| `cookie_value_invalid`         | Invalid cookie value syntax                                                           |
| `cookie_name_duplicate`        | Conflicting cookie name already in the jar                                            |
| `cookie_attribute_duplicate`   | Duplicate cookie attribute                                                            |
| `cookie_secure_attribute`      | Secure attribute has a value                                                          |
| `cookie_max_age`               | Invalid Max-Age syntax                                                                |
| `cookie_expires`               | Invalid Expires date                                                                  |
| `cookie_domain`                | Cookie domain outside the allowlist                                                   |
| `cookie_path_invalid`          | Invalid cookie path syntax                                                            |
| `cookie_path_mismatch`         | Cookie path excludes the requested endpoint                                           |
| `cookie_partitioned`           | Partitioned cookie rejected                                                           |
| `cookie_secure_prefix`         | Secure-prefix requirements fail                                                       |
| `cookie_host_prefix`           | Host-prefix requirements fail                                                         |
| `cookie_none_applicable`       | No unexpired cookie remains                                                           |

These diagnostics do not change admission, classification order, cookie
acceptance, retry policy or gate outcomes. Other errors may omit a reason;
absence does not imply a particular failed rule. In particular, unrelated
HTTP, rate-limit, timeout and shared response-schema failures retain their
existing codes without added diagnostics.

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
retry delay and retryability. For a failed `ConnectorError`, the runtime passes
its `retryable` value through rather than inferring it from the status or code.

The injected `HttpClient.request` receives court, purpose, GET or read-only
POST, URL, allowed headers, optional string body and expected JSON or HTML. It
returns status, headers, text and requested/received instants. A request rejected
by the allowlist makes no gate calls; rejected bodies are cancelled.
`createConnectorRuntime` takes the tenant, profile, lease scope, gate, fetch and
clock explicitly. Wrap each read or identity operation with its `execute`
method so a per-read lease includes parsing.

For a profile with cookies, the runtime keeps bootstrap `Set-Cookie` rows only
in memory and sends a cookie header only when it matches a scoped jar issued to
that runtime or imported from a scoped package-owned session. An unknown cookie
is rejected before gate admission. See the platform README for supported reuse.

Discovery and live checks use one gate per upstream site across courts, workers
and iterations. `politeGate` serializes a site's requests in memory and waits
2.5 seconds by default, with a configurable minimum of 2 seconds. Share the
same instance among concurrent clients for that site, and coordinate separate
local processes to maintain the same pacing. A failed outcome defers queued
work for at least 60 seconds or a longer supplied retry delay; an access block
stops the gate. `GateOutcome.retryAfterMs` carries a supplied delay, and the
runtime parses `Retry-After` for 429 responses; it does not forward that header
for other error statuses. Scheduled production collection supplies its own gate
and retains its existing cadence.

HTTP admission and guarded dispatch require version 1.1.0 or later; version
1.1.0 is unreleased. Each job still supplies its own gate and request authority.

`createHttpAdmissionGate({ reserveUrl, outcomeUrlTemplate, sourceOrigin, bearer,
localGate, serviceFetch?, signal? })` optionally combines a local gate with a
shared HTTP admission service. Reuse the local gate for concurrent requests
to that site; the service coordinates the shared budget. The reserve and
outcome URLs must have the same HTTPS origin
(HTTP loopback is supported for testing); configure exactly one source origin.
The outcome URL template contains one `{reservationId}` path segment. The
service receives a request purpose when reserving, and a bounded result and
observed status when recording an outcome. The bearer is sent only in the
service's authorization header. A deferral, malformed or lost service reply,
failed outcome report, or mismatched source fails closed. There is no service
retry or provider retry. Unknown and proven pre-fetch outcomes are never
reported as successful; they do not imply that a reservation was refunded.

The reserve POST body is `{ "purpose": "calendar" }`, using a contract request
purpose. A successful reserve reply is either
`{ result: "reserved", reservationId, allowanceOwner, budgetDate, used, cap, warningCrossed }`
or `{ result: "deferred", deferUntil, operatorHold }`. IDs are UUIDs, the
budget date is a UTC date, counts are nonnegative safe integers, and the cap is
positive. A deferral's `deferUntil` is a UTC instant or null. Outcome POST
bodies contain `result` (`success`, `rate_limited`, `access_blocked`, `http_error`, `unknown`
or `not_sent`), optionally `status`, `errorCode` and `retryAfterMs`; error codes
come from the connector contract. Retry delays are nonnegative safe integers;
an invalid delay is omitted without suppressing a recognized block. A successful
reply is `{ "recorded": true }`;
an unauthorized or conflicting reply fails closed. The result is authoritative:
an observed challenge remains `access_blocked` even when its status is 5xx.
`unknown` and `not_sent` carry no status. The service receives neither a source
URL nor provider credentials.

This gate requires a runtime with ticket-bound dispatch support. On admission,
the runtime passes the gate's exact `dispatch` function as the optional second
`acquire` argument. The gate refuses admission without that capability. A
dispatch hook must synchronously call the supplied `send` once and return that
same promise. The runtime alone enters the actual fetch, marks that entry,
rechecks its deadline and cookie proof, and rejects a substituted result or a
late or repeated send. Ordinary gates without `dispatch` keep the existing
one-argument acquire and fetch behavior. A controller must verify this runtime
capability before enabling the HTTP gate; installing a gate beside an older
runtime does not enable guarded dispatch.

When a scoped session is combined with guarded dispatch, the selected session
scope and cookie proof are checked again at the actual fetch entry. Expiry or
invalidation before that entry prevents the fetch and reports `not_sent` for
the already acquired reservation. Each job retains its own gate, signal and
deadline even when it reuses a successful bootstrap proof.

With guarded dispatch, the runtime inspects up to 64 KiB and 4,096 chunks for
known challenge markers when a response would otherwise fail as an HTTP error,
including a bare 401. A recognized challenge is reported as `access_blocked`
with the observed status; an inconclusive or failed probe keeps the HTTP error.
A bare 401 stops the current gate and is not reported as a shared host block.
The probe uses the request deadline and cancels the body. Successfully read
bodies use the ordinary size limit and are checked for known challenge markers.
For a per-read lease, an observed 401, 403, 429, authentication failure or
challenge remains the release outcome even if the read callback catches or
replaces the request error. Ordinary gates retain their profile's existing
response order.

`leaseScope: "per_read"` releases after the whole read or identity check,
including parsing, and reports its final outcome. `"per_request"` releases
after each response is classified, including a platform's payload-level
classification hook. This distinction ensures parser-time access blocks reach
the appropriate gate. A `per_read` operation may make one request; a second
request fails before gate admission. A platform with multiple requests per
operation uses `per_request` in version 1.

Transport profiles declare retry-after parsing, success statuses, classification
order, header-name handling, fetch input form, abort retry behavior, redirect
headers, content-length checks, accepted content types,
challenge rules, allowed headers, method-specific URL grammar, cookie-jar
policy and an optional classifier. Header rules can require an exact value,
limit length or forbid a header for particular purposes. URL grammar validates
method, segment count, identifiers, dates and query, rather than only a prefix;
it receives the runtime tenant and request purpose so it can bind paths to the
configured origin and tenant. The strict cookie jar allows configured domains;
its row limit, byte limit, partition and secure-prefix rules are fixed.
Classification order controls when a successful response's body is read. Error
statuses are classified and their bodies cancelled unread in all profiles.
Unsupported profile fields are rejected.
An optional `classifyJsonForHtml` policy lets the transport parse and classify
declared JSON before releasing an HTML-expected request. The caller still
enforces its expected HTML type after release; without the policy, unexpected
JSON is rejected before release.

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

The standard profile classifies requests in this order: fetch failure, redirect, 401/403, 429, 5xx,
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
success and JSON content type. CivicRec's explicit legacy-body-first profile
first rejects `response.redirected` and leaves non-200 bodies unread. For a 200,
it checks Content-Length, reads the bounded body, checks unencoded length, then
decodes fatal UTF-8 before checking Location, Refresh, content type and payload.
An empty HTML body reaches the bootstrap parser after a successful per-request
release. JSON bootstrap responses are classified before release, then a valid
JSON response is rejected by the reader's HTML type check after release. This
preserves the existing order for compound failures. CivicRec marks a transport
failure retryable only when its signal was actually aborted; a timeout-named
error alone does not qualify. ActiveNet and the default profile also recognize
timeout-like errors and causes without an aborted signal.

Optional transport policies preserve observable cancellation behavior.
`timeoutSignal: "native"` uses `AbortSignal.timeout(15000)` and its native
reason and lifetime; otherwise a controller owns the deadline.
`timeoutReason: "abort-error"` makes that controller abort with its default
`AbortError` instead of `TimeoutError`. `abortFailure: "retryable-http"`
normalizes a bounded abort or deadline to a retryable `http_error` without
changing the fetch signal's reason. `cleanupAbort` selects `before-body`,
`after-body` (the default), or `none` for controller cleanup. ActiveNet uses
the native timeout without a cleanup abort. CivicRec aborts before body
disposal and preserves failure classification from before that cleanup, so a
non-aborted stream failure does not become retryable merely during disposal.
Both legacy profiles use `transportErrors: "http-only"`: errors thrown by
fetch or stream reads are HTTP failures, even when the thrown value resembles
a classified connector error. A caller can explicitly map its own trusted
error instances with `classifyTransportError`; returning `undefined` keeps
the ordinary transport policy. Classification and gate failures retain their
typed controls. Profiles that omit `transportErrors` preserve the previous
typed transport-error behavior.

## Shapes and reason codes

`full_calendar` lists open and taken slots, so a usable complete day may have
explicit `available: false` intervals. A visible partial full-calendar day is
unusable; any retained interval flags are source evidence, not an availability
result. `continuous_ranges` reports open ranges only: a usable day has partial
coverage, reported-only evidence and only `available: true` intervals. A
reported-range day never has complete coverage, even when unusable, and never
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

## Provider setup and session reuse

The optional `createSessionStore` API requires version 1.1.0 or later; version
1.1.0 is unreleased. It supports anonymous, process-local reuse only.

Minimize actual upstream requests. Reuse successful setup, bootstrap and
authentication while their scope and validity still apply. Scope sessions to
the configured origin, tenant and account, including the relevant transport and
configuration identity. Never share one tenant's or account's session with
another. Share in-flight setup only within that same scope; a failed setup is
not reusable session state.

Session state and request authority have separate lifetimes. A job's runtime,
gate, lease, cancellation signal and deadline belong to that job. Sharing a
session must not reuse another job's authority. Cookie proofs remain owned by
the package: callers cannot manufacture valid setup by copying cookie strings
into a new runtime. See the platform README for the implemented reuse boundary.

Document measured cold and warm request counts, the reuse scope and local
lifetime, known provider expiry signals, invalidation and any bounded renewal.
Distinguish provider evidence from caller policy: an unknown server lifetime
stays unknown. Ordinary errors, timeouts, rate limits, blocks and challenges do
not by themselves prove that another login is needed. Do not create an
authentication or bootstrap retry loop; any caller-controlled retry must pass
admission and backoff again.

All actual outbound attempts count toward the caller's shared host budget,
including setup, authentication, metadata, calendars, redirects and retries.
Coordinate independent workers and local/manual callers through the same
authoritative budget. A conservative charged reservation after cancellation or
an uncertain send is distinct from a proven HTTP transmission. Report the
configured warning crossing and the first block/rate-limit response through
the caller's existing alerts; a connector adds no monitoring timer.

Preserve the original setup and response provenance when reusing state. Cached
HTTP bytes are not a new upstream read and must never be presented as one.
Keep credentials, cookies and session material out of readings, logs and
fixtures. Test scoped reuse, concurrency, expiry, failed setup and invalidation
with synthetic responses, while preserving the platform's ordinary outputs.

## Conformance

`@courttide/connectors/testing` exports `runConformance`, a scripted fake
fetch, recording gate, frozen clock and the case matrix. The runner takes a
platform and fixture directory and uses the shared runtime with the scripted
fetch and a controlled wall and monotonic clock. An optional harness factory can
instead receive the fake fetch, recording gate, tenant and clock and return an
`HttpClient` and operation wrapper. The wrapper lets a runtime release a per-read
ticket after parsing. The default does not use a live network; an injected
harness must use the supplied fake fetch.
The testing entrypoint also exports `parseCivicrecHours` and its types for
parser-only parity cases. Keep real inputs and their parser results private.

Each case directory contains `meta.json` with a source, case names, `clockNow`,
configuration path, court and date range. It has `responses.json`,
`requests.json`, `gate.json`, and exactly one of `expected.json` or
`error.json`. Optional metadata declares allowed courts, marked synthetic
secrets, a gate deferral, an identity operation or an expected reflected-secret
failure. An optional `clockSequence` contains 1 to 16 instants, returned in
order for successive clock calls; later calls repeat the last instant. Without a
sequence, the clock stays at `clockNow`. Public metadata has
`"source": "synthetic"`; use the example config under `examples/tenants/` and
keys from 900001 through 900099.

The runner compares request URLs, headers, bodies and fetch options in order;
gate acquires, releases and outcomes; and output or error fields. It validates
the reading and checks sanitized output against marked secrets. A reflected
session key or cookie on a bootstrapped platform must fail with
`schema_changed`. A rejected request has no gate calls; a deferred acquire has
no release; a parser-time block reaches the applicable release.
These comparisons cover the supplied fetch initialization, not headers added by
the native HTTP stack on the wire.

Recorded header objects keep their original key order, spelling and string
values. Header tuple arrays keep their order and duplicates. An already-created
`Headers` object is recorded distinctly as `{kind: "Headers", entries: [...]}`
using its observable entries. Synthetic response fixtures may use ordered
header tuples for repeated fields and `bodyBytes` for exact byte sequences.
`bodyRepeat` creates a bounded synthetic repeated-character body for size tests.

The repository data check scans tracked text and the packed package for
non-example identifiers, tenant and catalog paths, slugs, unmarked hashes,
non-synthetic fixture metadata and private references. It does not replace a
review of the actual diff and packaged contents. Synthetic JSON objects that
include a real-shaped `detailsTextSha256` mark it with a sibling
`detailsTextSha256Synthetic: true`. YAML may instead use a `# synthetic`
comment on the hash line.

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
