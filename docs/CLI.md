# Command line

The CLI reads one configured court at a time. It supports `read`, `serve`,
`replay`, `record`, `check`, `test:live` and `list`.

## Offline example

From a clone, install the pinned dependencies and start a loopback fixture
server in one terminal:

```sh
npm ci
npm run cli -- serve examples/activenet/fixtures/cases/midnight-end
```

The server prints its loopback URL and stays open until interrupted. In another
terminal, run the matching synthetic config and fixture through the real
platform, transport and gate:

```sh
npm run cli -- read activenet \
  --config examples/tenants/activenet.json \
  --court 900001 \
  --date 2026-10-31 \
  --live \
  --base-url http://127.0.0.1:PORT
```

`--base-url` accepts only an HTTP loopback origin with an explicit port. The
platform URL is validated first; only the fetch destination is rewritten. This
keeps the production URL rules in force during offline tests.

Replay the full synthetic fixture collection with:

```sh
npm run cli -- replay examples/activenet/fixtures/cases
```

## Commands

`read <platform> --config <file> --court <key> --date YYYY-MM-DD [--days N] --live [--json]`
requires an explicit live flag and one court key. The span is limited to the
platform's `maxDaysPerRead`. Text output shows each date's status, visibility,
coverage, usability and open windows, followed by the CourtTide credit line.
JSON output goes to standard output and sends that credit line to standard
error. Use CourtTide's public MCP for multi-park reads.

`serve <fixture-dir>` binds only to `127.0.0.1`. Pass one fixture case directory
to avoid ambiguous routes. It serves synthetic request/response pairs and does
not contact a provider.

`replay <fixture-dir>` runs conformance checks offline against saved expected
outputs, requests and gate calls.

`record <platform> --config <file> --court <key> --date YYYY-MM-DD --live --case <name>`
stores a scrubbed local recording below the git-ignored `local/` directory. It
omits request header values, the original response body and source URL, and
refuses to write if the destination is not ignored or resolves into `fixtures/`.

`check [paths...]` validates JSON tenant configs, runs available platform
conformance fixtures and the repository data guard. With no paths, it checks
`examples/tenants/`.

`test:live --config <dir> [--platform <id>] [--courts <key,...>]` runs local
integration reads using the current date in each config's time zone. Specify
`--base-url` with a loopback fixture server to keep the run offline. Without
that option the selected read uses the configured provider origin.

`list` prints registered platform IDs, parser versions and capabilities. It
does not print tenant configuration.
