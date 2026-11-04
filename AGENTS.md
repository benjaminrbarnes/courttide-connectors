# Working in this repository

Read [CONTRIBUTING.md](CONTRIBUTING.md) and [the new connector guide](docs/NEW-CONNECTOR.md).

- Never commit secrets, member data, real court data or tenant configurations, real responses, research or internal URLs. Example configurations and fixtures must be synthetic. Use example keys from 900001 through 900099 and slugs beginning `example-`.
- Do not add terms reviews or permission notes.
- In pull requests, issues, commits and releases, name platforms only. Do not include tenants, cities, courts, counts or coverage.
- For discovery, begin with a fresh private window or empty browser profile; the first request to a host must have no cookies. Visit public pages and observe the calls they make. Reuse authorized sessions as needed, but do not sign in with a member account or enter a booking flow. Stop at the first 403, 429 or challenge; never bypass a block. Keep discovery data private.
- Exercise judgment for ordinary browsing and test-and-adjust sessions. Across all courts, workers and iterations, share a gate per connector and upstream target: leave at least 10 seconds between requests, and allow at most 6 per rolling minute, 20 per rolling 10 minutes and 30 per rolling hour. These are ceilings, not quotas. Coordinate separate processes through the caller's existing admission, gate, lease, priority and backoff; do not use parallelism to evade the shared limit.
- Live checks and recordings use private configuration and the same shared ceilings. Never run them in CI.
- Tests and CI use synthetic data and never contact booking sites. Delete HAR files and close browser tabs after use.
- Claude reviews after merge as `Claude review:` pull request comments. Check recent comments before starting work.
