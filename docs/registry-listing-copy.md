# Registry listing copy

Use this copy after the public MCP endpoint at `https://courttide.com/mcp/public` answers unauthenticated `tools/list`. Until then, this metadata is prepared but unpublished; it does not assert that the endpoint is live.

**Name:** CourtTide

**Short description:** Public park facts need no key; saved times use a bearer key at https://courttide.com/mcp.

**Repository:** https://github.com/benjaminrbarnes/courttide-connectors

**Public endpoint:** https://courttide.com/mcp/public

## Account-required directories

- [Official MCP Registry](https://modelcontextprotocol.io/registry/quickstart): publish the remote-only `server.json` with `mcp-publisher`. GitHub namespace authentication is required for the `io.github.benjaminrbarnes` name. Ben performs the device login; do not publish before the public endpoint passes the readiness check above.
- [Glama](https://glama.ai/mcp/servers): Glama documents automatic indexing from the Official Registry. Sign in only if claiming or managing the imported listing; avoid creating a duplicate manual listing.
