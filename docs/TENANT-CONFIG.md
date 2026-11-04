# Tenant configuration

A configuration maps a caller's parks and courts to a platform. Real configs are
caller data: keep them outside this repository. The files in
[`examples/tenants/`](../examples/tenants/) are invented examples only. Use
`TenantConfigSchema` or the exported JSON Schema to validate the common shape;
each platform also exports parameter schemas for its own `params` fields.

The common fields are:

- `schemaVersion: "1"`, a platform ID and a stable tenant key.
- An IANA `timeZone`, an `origin` with no path or credentials, and platform
  `params` such as a base path or catalog path.
- `parks`, each with a stable key, display name, optional `courttideSlug`,
  optional `publicTimes` and `courts`.
- Each court's stable key, label, optional platform label and retirement date,
  and platform-specific `params`.

See [`example.json`](../examples/tenants/example.json) for the complete
synthetic shape. Public examples use keys `900001` through `900099`, invented
names and synthetic markers for example hashes. The allowed synthetic `tenant`
values are exactly `example`, `exampleparks` and `XX/example-city`; choose the
form appropriate to the example. These tenant values are distinct from park
and CourtTide slugs, which begin with `example-`. A synthetic CivicRec
`catalogPath` is `/XX/example-city/catalog`; the allowed synthetic `basePath`
values are `/exampleparks`, `/exampleparks/` and `/XX/example-city/`. Never
replace these with your own real IDs, labels or responses.

`publicTimes` omitted means unchecked; `false` means open times are not
published; `true` means the caller has established that they are published.
Configuration does not enable collection. A moved court gets a new stable key;
retain its old entry with `retired: "YYYY-MM-DD"`. The optional `courttideSlug`
adds a park URL to attribution; leave it out if there is no matching page.

Pass the validated configuration to the platform and shared runtime. The
caller supplies `fetch`, a gate and a clock. Keep a stateful connector and its
runtime together so bootstrap cookies stay scoped to the issuing session. The
[network seam](CONTRACT.md#network-seam) explains request limits and lease
handling.
