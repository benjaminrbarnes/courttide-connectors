# Teaching template

This is a fake, offline platform. It shows a request builder, an allowlisted
transport profile, a small parser, a connector and a synthetic conformance case.
It always uses `example.invalid`; it is not a supported live platform.

Run its test with `npx vitest run platforms/_template/conformance.test.ts`.
Read the [new connector guide](../../docs/NEW-CONNECTOR.md) before copying it.

The template exercises `open_interval`. Its other matrix entries are marked
**demonstration only** so this one-case example can run. Those placeholders are
not a production conformance claim: a copied demo can pass with them unchanged.
For a real platform, remove each placeholder and add a fixture, or explain
specifically why that case cannot occur. Run the complete matrix and update the
new platform's README before requesting review.
