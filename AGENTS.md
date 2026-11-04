# Working in this repository

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [the new connector guide](docs/NEW-CONNECTOR.md).

- Never commit secrets, member data, court data, tenant configurations, real responses, research or internal URLs. Fixtures must be synthetic. Use example keys from 900001 through 900099 and slugs beginning `example-`.
- Do not add terms reviews or permission notes.
- In pull requests, issues, commits and releases, name platforms only. Do not include tenants, cities, courts, counts or coverage.
- For discovery, use a fresh private window or empty browser profile. The first request to a host must have no cookies. Visit only public pages, observe the calls the page makes, and do not sign in or enter a booking flow. Per tenant, use at most 30 page loads and 20 replays, at least 10 seconds apart, for one or two courts on one to three dates. Stop at the first 403, 429 or challenge; never bypass a block. Keep discovery data private.
- Live checks and recordings use private configuration, run at least 10 seconds apart, and never run in CI or between 22:00 and 06:00 in the local time zone. Live checks read at most two courts on two dates per platform. Recordings count against the discovery budget.
- Tests and CI use synthetic data and never contact booking sites. Delete HAR files and close browser tabs after use.
- Claude reviews after merge as `Claude review:` pull request comments. Check recent comments before starting work.
