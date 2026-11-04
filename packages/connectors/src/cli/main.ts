#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { ConnectorError, GateDeferred } from "../contract/errors.js";
import { runCommand } from "./commands.js";
import type { CliIO } from "./types.js";

export async function runCli(
  argv: readonly string[],
  io: CliIO,
): Promise<number> {
  try {
    await runCommand(argv, io);
    return 0;
  } catch (error) {
    if (error instanceof ConnectorError)
      io.stderr(`Connector read failed: ${error.code}`);
    else if (error instanceof GateDeferred)
      io.stderr(`Request deferred until ${error.until} (${error.reason}).`);
    else io.stderr(error instanceof Error ? error.message : "Command failed");
    return 1;
  }
}

async function main(): Promise<void> {
  const io: CliIO = {
    cwd: process.cwd(),
    stdout: (message) => process.stdout.write(`${message}\n`),
    stderr: (message) => process.stderr.write(`${message}\n`),
  };
  process.exitCode = await runCli(process.argv.slice(2), io);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await main();
}
