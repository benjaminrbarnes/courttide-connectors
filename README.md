# CourtTide connectors

Open-source, read-only connectors for court availability. CourtTide is
integrating the package for its own court times. Connectors report source facts
without booking or inferring that unreported time is unavailable.

## Supported platforms

<!-- supported-platforms:start -->

- [ActiveNet](platforms/activenet/README.md)
- [CivicRec](platforms/civicrec/README.md)

<!-- supported-platforms:end -->

This list is generated from the platform entrypoints and their READMEs. Run
`npm run docs:platforms` after adding a platform.

## Quick start

Use Node 24 or later:

```sh
git clone https://github.com/benjaminrbarnes/courttide-connectors.git
cd courttide-connectors
npm ci --ignore-scripts
npm run check
npm run build
node --input-type=module -e "import { activeNetPlatform } from '@courttide/connectors/activenet'; console.log(activeNetPlatform.id)"
```

The check and examples are synthetic and make no provider requests. For real
reads, supply your own configuration, HTTP runtime and shared gate as described
in the [contract](docs/CONTRACT.md) and [tenant guide](docs/TENANT-CONFIG.md).
The package has not yet been published to npm.

Want many parks? The planned [CourtTide public MCP](https://courttide.com/mcp/public)
will provide a shared alternative.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md), the
[new connector guide](docs/NEW-CONNECTOR.md) and the
[template](platforms/_template/README.md).

## Credit

When you display data, please keep its `attribution` field and include:

Court times read with [courttide-connectors](https://github.com/benjaminrbarnes/courttide-connectors) by [CourtTide](https://courttide.com).

[![Read with CourtTide](https://img.shields.io/badge/read%20with-CourtTide-1f6f5c)](https://courttide.com)

The MIT license covers the code. It doesn't cover the CourtTide name or logo, so forks can't present themselves as official.
