import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import { TenantConfigSchema } from "../contract/schemas.js";
import type { Platform, TenantConfig } from "../contract/types.js";
import { parseArgs, singleOption } from "./args.js";
import { configFiles, loadConfig, validatePlatformConfig } from "./config.js";
import { replayFixtures, startFixtureServer } from "./fixtures.js";
import {
  createCliGate,
  formatReading,
  parseReadOptions,
  readCourt,
} from "./read.js";
import { writeRecording } from "./record.js";
import { conformanceFixturePath, listPlatforms } from "./registry.js";
import type { CliIO, ReadOptions } from "./types.js";

const creditLine =
  "Read with courttide-connectors by CourtTide · https://courttide.com";

function usage(): string {
  return [
    "Usage:",
    "  courttide-connectors read <platform> --config <file> --court <key> --date YYYY-MM-DD [--days N] --live [--json]",
    "  courttide-connectors serve <fixture-dir> [--port N]",
    "  courttide-connectors replay <fixture-dir>",
    "  courttide-connectors record <platform> --config <file> --court <key> --date YYYY-MM-DD --live --case <name>",
    "  courttide-connectors check [paths...]",
    "  courttide-connectors test:live --config <dir> [--platform <id>] [--courts <key,...>]",
    "  courttide-connectors list",
  ].join("\n");
}

function unknownPlatformPlatform(id: string): Platform | undefined {
  return listPlatforms().find((platform) => platform.id === id);
}

function readOptions(args: readonly string[]): ReadOptions {
  const parsed = parseArgs(
    args,
    ["config", "court", "date", "days", "base-url"],
    ["live", "json"],
  );
  const options = parseReadOptions(parsed);
  if (options.baseUrl) {
    // The fetch wrapper may change origin only after the production profile validates the source URL.
    new URL(options.baseUrl);
  }
  return options;
}

async function commandRead(args: readonly string[], io: CliIO): Promise<void> {
  const options = readOptions(args);
  const result = await readCourt(options, io);
  const tenant = loadConfig(options.config, io.cwd);
  if (options.json) {
    io.stdout(JSON.stringify(result.reading, null, 2));
    io.stderr(creditLine);
  } else {
    io.stdout(formatReading(result.reading, tenant.timeZone));
  }
}

async function commandRecord(
  args: readonly string[],
  io: CliIO,
): Promise<void> {
  const parsed = parseArgs(
    args,
    ["config", "court", "date", "days", "base-url", "case"],
    ["live"],
  );
  const options = parseReadOptions(parsed);
  const name = singleOption(parsed.values, "case", true)!;
  const result = await readCourt(options, io);
  const path = writeRecording(io.cwd, name, result, io.now?.() ?? new Date());
  io.stdout(`Scrubbed local recording written: ${path}`);
}

async function commandServe(args: readonly string[], io: CliIO): Promise<void> {
  const parsed = parseArgs(args, ["port"]);
  if (parsed.positional.length !== 1)
    throw new Error("Usage: serve <fixture-dir> [--port N]");
  const portText = singleOption(parsed.values, "port");
  const port = portText === undefined ? 0 : Number(portText);
  if (!Number.isSafeInteger(port)) throw new Error("--port must be an integer");
  const started = await startFixtureServer(
    resolve(io.cwd, parsed.positional[0]!),
    port,
  );
  io.stdout(started.url);
  if (io.onServe) {
    try {
      await io.onServe(started.url, started.close);
    } finally {
      await started.close();
    }
    return;
  }
  await new Promise<void>((resolveStop) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      void started.close().finally(resolveStop);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function findRepoRoot(cwd: string): string | undefined {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, "scripts", "check-no-court-data.mjs")))
      return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function validateConfigFile(path: string): TenantConfig {
  try {
    return TenantConfigSchema.parse(
      JSON.parse(readFileSync(path, "utf8")),
    ) as TenantConfig;
  } catch {
    throw new Error(`Invalid tenant config: ${path}`);
  }
}

async function commandCheck(args: readonly string[], io: CliIO): Promise<void> {
  const paths = args.length ? args : ["examples/tenants"];
  const configs = paths.flatMap((path) => configFiles(path, io.cwd));
  if (!configs.length) throw new Error("No tenant config files found");
  for (const path of configs) {
    const tenant = validateConfigFile(path);
    const platform = unknownPlatformPlatform(tenant.platform);
    if (platform) validatePlatformConfig(tenant, platform);
  }
  const platforms = listPlatforms();
  let fixtureCount = 0;
  for (const platform of platforms) {
    const fixtureRoot = resolve(io.cwd, conformanceFixturePath(platform.id));
    if (!existsSync(fixtureRoot)) continue;
    const result = await replayFixtures(fixtureRoot);
    if (result.platform.id !== platform.id)
      throw new Error("Fixture platform does not match its directory");
    fixtureCount += result.fixtures;
  }
  const root = findRepoRoot(io.cwd);
  if (!root)
    throw new Error("check must run inside a connector source checkout");
  if (io.checkRepository) io.checkRepository(root);
  else
    execFileSync(process.execPath, ["scripts/check-no-court-data.mjs"], {
      cwd: root,
      stdio: "ignore",
    });
  io.stdout(
    `Checked ${configs.length} tenant config(s), ${fixtureCount} conformance fixture(s), and repository data guard.`,
  );
}

function localDate(now: Date, timeZone: string): string {
  return Temporal.Instant.from(now.toISOString())
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();
}

async function commandTestLive(
  args: readonly string[],
  io: CliIO,
): Promise<void> {
  const parsed = parseArgs(args, ["config", "platform", "courts", "base-url"]);
  if (parsed.positional.length)
    throw new Error("test:live accepts only options");
  const configPath = singleOption(parsed.values, "config", true)!;
  const platformFilter = singleOption(parsed.values, "platform");
  const courtOption = singleOption(parsed.values, "courts");
  const selectedCourts = courtOption
    ?.split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  if (
    selectedCourts &&
    (!selectedCourts.length ||
      new Set(selectedCourts).size !== selectedCourts.length)
  )
    throw new Error("--courts must contain unique court keys");
  const baseUrl = singleOption(parsed.values, "base-url");
  if (baseUrl) new URL(baseUrl);
  const files = configFiles(configPath, io.cwd);
  if (!files.length) throw new Error("No tenant configs found");
  const targets: {
    options: ReadOptions;
    timeZone: string;
    minimumGapMs: number;
  }[] = [];
  const foundCourts = new Set<string>();
  for (const file of files) {
    const tenant = loadConfig(file, "/");
    if (platformFilter && tenant.platform !== platformFilter) continue;
    const platform = unknownPlatformPlatform(tenant.platform);
    if (!platform) {
      if (platformFilter)
        throw new Error(`Unsupported platform: ${platformFilter}`);
      continue;
    }
    const capabilities = validatePlatformConfig(tenant, platform);
    const available = new Set(
      tenant.parks.flatMap((park) => park.courts.map((court) => court.key)),
    );
    const courts = selectedCourts
      ? selectedCourts.filter((court) => available.has(court))
      : [...available].slice(0, 1);
    for (const court of courts) {
      foundCourts.add(court);
      targets.push({
        options: {
          platform: tenant.platform,
          config: file,
          court,
          date: localDate(io.now?.() ?? new Date(), tenant.timeZone),
          days: Math.min(1, capabilities.maxDaysPerRead),
          json: false,
          ...(baseUrl ? { baseUrl } : {}),
        },
        timeZone: tenant.timeZone,
        minimumGapMs: capabilities.minimumGapMs,
      });
    }
  }
  const missingCourts =
    selectedCourts?.filter((court) => !foundCourts.has(court)) ?? [];
  if (missingCourts.length)
    throw new Error(
      "A selected court is missing from the matching config directory",
    );
  if (!targets.length)
    throw new Error("No matching configured court was selected");
  const execution = createCliGate(
    Math.max(...targets.map((target) => target.minimumGapMs)),
  );
  for (const target of targets) {
    const result = await readCourt(target.options, io, execution);
    io.stdout(formatReading(result.reading, target.timeZone));
  }
}

function commandList(io: CliIO): void {
  const values = listPlatforms().map((platform) => ({
    id: platform.id,
    parser: platform.parser,
    capabilities: platform.capabilities({} as TenantConfig),
  }));
  io.stdout(JSON.stringify(values, null, 2));
}

export async function runCommand(
  args: readonly string[],
  io: CliIO,
): Promise<void> {
  const [command, ...rest] = args;
  switch (command) {
    case "read":
      return commandRead(rest, io);
    case "serve":
      return commandServe(rest, io);
    case "replay": {
      if (rest.length !== 1) throw new Error("Usage: replay <fixture-dir>");
      const result = await replayFixtures(resolve(io.cwd, rest[0]!));
      io.stdout(
        `Replay passed for ${result.platform.id}: ${result.fixtures} fixture case(s), ${result.cases.length} assertions.`,
      );
      return;
    }
    case "record":
      return commandRecord(rest, io);
    case "check":
      return commandCheck(rest, io);
    case "test:live":
      return commandTestLive(rest, io);
    case "list":
      if (rest.length) throw new Error("Usage: list");
      commandList(io);
      return;
    case "--help":
    case "-h":
    case "help":
    case undefined:
      io.stdout(usage());
      return;
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}
