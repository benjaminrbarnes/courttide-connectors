# Build a connector

This guide is for a public, anonymous, read-only booking platform. Start with the
[contract](CONTRACT.md), [response shapes](RESPONSE-SHAPES.md) and
[teaching template](../platforms/_template/README.md). Use Node 24 or later:

```sh
npm ci --ignore-scripts
npx vitest run platforms/_template/conformance.test.ts
npm run check
```

The template is a deliberately small fake. It uses `example.invalid`, a
synthetic key and fake fetch; it never calls a booking provider. Its placeholder
matrix exemptions are not a complete platform submission.

## Observe the public read flow

Use your own fresh private browser window or empty profile, with no booking-site
cookies. In DevTools confirm the first request to each booking host has no
`Cookie` header. Visit as a public user: no sign-in, account creation, cart,
hold, waitlist, booking, payment or checkout. Observe calls made by the page;
never invent an endpoint. Stop at the first 403, 429 or challenge and do not
bypass it.

For local discovery and `test:live`, coordinate human-paced reads per upstream
site across courts, local workers, sessions and iterations. Wait roughly 2–3
seconds between requests, with a 2.5-second default and a 2-second minimum.
The CLI shares a `politeGate` per origin within a run; coordinate separate local
processes so their combined activity follows the same pacing. Honor
`Retry-After` and stop at the first 403, 429 or challenge. Local checks do not require
production database access, production transactions, SSH access or worker
leases. Deployed callers keep their existing budgets, admission, leases and
backoff.
Live checks and recordings stay out of CI.

In Chrome or Brave, open DevTools before loading the page. In **Network**, turn
on **Preserve log** and **Disable cache**, start with the Fetch/XHR filter and
use Doc when HTML is rendered by the server. Walk through the few public
navigation steps needed to see a single date. Identify the request that changes
with the date and note its method, ordered URL and query, relevant headers,
content type, response structure, and where any session value came from. The
initiating script can reveal status and time rules.

Compare what the page visibly reports with its response. Identify resource and
rate identifiers, date and time zone, slot duration and increment, midnight and
clock-change behavior, and whether the source reports full calendars, open
ranges or something else. Do not guess unknown statuses or infer that an absent
range is booked. Keep observations and captured responses private; scrub
cookies, authorization, session values and personal data before retaining them.
Only generic shapes and invented examples belong in this repository.

## Implement and test

1. Copy `platforms/_template/` to `platforms/<id>/`. Use a lowercase kebab-case
   platform ID and keep only synthetic files in the copy.
2. Place the implementation at `packages/connectors/src/platforms/<id>/` and
   export its `Platform` from `index.ts`. If moving the template's source there,
   change its `../../packages/connectors/src/index.js` imports to
   `../../index.js`. Keep the test in `platforms/<id>/`; change its platform
   import from `./index.js` to
   `../../packages/connectors/src/platforms/<id>/index.js`, and change its
   fixture directory to `platforms/<id>/fixtures`.
3. Define tenant and court parameter schemas, capabilities, parser identity,
   request builder, method-specific URL grammar and allowed headers. Bind paths
   to the configured origin and tenant. Use the injected `HttpClient`; do not
   call `fetch` in a connector. Use the supplied runtime for bounded responses,
   leases and the gate. Never implement booking calls or retries.
4. Add the package subpath export in `packages/connectors/package.json`, using
   `./dist/platforms/<id>/index.d.ts` for `types` and
   `./dist/platforms/<id>/index.js` for `default`. Add a
   `platforms/<id>/README.md` headed `# Display Name platform` or
   `# Display Name connector`. Describe calls, response shape, statuses, time
   rules, reason codes and transport profile without tenant or court details.
   Register the platform and its fixture path as described in the
   [CLI guide](CLI.md).
5. Add an invented config under `examples/tenants/`, using the reserved keys
   and `example-` slugs, and update each fixture's `configPath` to point to it.
   The synthetic `tenant` value must be exactly `example`, `exampleparks` or
   `XX/example-city`; it is not an arbitrary `example-` slug. Keep all real
   configs outside the repository. See the [tenant guide](TENANT-CONFIG.md).
6. Replace the template fixture and all its demonstration-only exemptions. Each
   case directory needs `meta.json`, `responses.json`, `requests.json`,
   `gate.json` and exactly one of `expected.json` or `error.json`. Set
   `source: "synthetic"` and list any invented secrets in `meta.json`. The
   [contract](CONTRACT.md#conformance) explains exact ordering and the complete
   case matrix. Add a fixture for every applicable case; document a specific
   reason in the platform README for each case that cannot occur.
7. Run `npx vitest run platforms/<id>/conformance.test.ts`,
   `npm run docs:platforms` and `npm run check`. Review
   the generated README list and packed-package data check. Fixtures prove the
   code's synthetic behavior; they do not prove a live provider works.

A fresh connector must preserve `attribution`, fail closed for malformed or
unobserved data, leave raw personal or session values out of its output and
keep source facts distinct from a booking decision.

## Add a tenant to an existing platform

Confirm the platform's public read shape and its time rules using the same shared
pacing. Write and validate your config outside this repository. Mark a source
that does not publish open times as `publicTimes: false`; do not infer openings.
Never open a public PR containing your real config, labels, IDs or responses.
