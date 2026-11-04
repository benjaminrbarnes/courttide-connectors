#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ConnectorError, GateDeferred } from "../contract/errors.js";
import { runCommand } from "./commands.js";
import { CliExit, type CliIO } from "./types.js";

export async function runCli(
  argv: readonly string[],
  io: CliIO,
): Promise<number> {
  try {
    await runCommand(argv, io);
    return 0;
  } catch (error) {
    if (error instanceof CliExit) return error.exitCode;
    if (error instanceof ConnectorError)
      io.stderr(`Connector read failed: ${error.code}`);
    else if (error instanceof GateDeferred)
      io.stderr(`Request deferred until ${error.until} (${error.reason}).`);
    else io.stderr(error instanceof Error ? error.message : "Command failed");
    return 1;
  }
}

export function isDirectExecution(
  moduleUrl: string,
  argvPath = process.argv[1],
): boolean {
  if (!argvPath) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(argvPath);
  } catch {
    return false;
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

if (isDirectExecution(import.meta.url)) await main();
