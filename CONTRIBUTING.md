# Contributing

Read [AGENTS.md](AGENTS.md), the [connector guide](docs/NEW-CONNECTOR.md) and
[contract](docs/CONTRACT.md). The [teaching template](platforms/_template/README.md)
provides a small offline starting point.

Keep court information and recorded responses outside this repository. Public
examples and fixtures are synthetic, use keys from `900001` through `900099`,
and use `example-` slugs. Do not commit secrets, personal data, session keys,
cookies, real tenant configuration, research or internal URLs.

For discovery, use your own fresh private browser window or empty profile.
The first request to a booking host must have no cookie. Observe only the public
read flow; do not sign in, create an account or enter a booking flow. Stop at the
first 403, 429 or challenge and never bypass it. Keep any captures private.

For local discovery and `test:live`, coordinate human-paced reads per upstream
site across courts, local workers, sessions and repeated iterations. Leave
roughly 2–3 seconds between requests, with a 2.5-second default and a 2-second
minimum. The CLI shares a `politeGate` per origin within a run; coordinate
separate local processes so their combined activity follows the same pacing.
Honor `Retry-After` and stop at the first 403, 429 or challenge. Local checks do
not require production database access, production transactions, SSH access or
worker leases. Deployed callers retain their existing budgets, admission,
leases and backoff. Live
checks never run in CI.

Before requesting review:

- Run `npm run check` and the platform's conformance test.
- Check that all fixtures are synthetic, with `source: "synthetic"` metadata,
  no secrets and no real configuration or recorded response.
- Update the platform README, document each inapplicable matrix case and run
  `npm run docs:platforms` when a supported platform changes.
- Name platforms only in PRs and commits; do not include tenant or court data.
