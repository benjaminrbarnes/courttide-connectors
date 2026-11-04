import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Temporal } from "@js-temporal/polyfill";
import { TenantConfigSchema } from "../contract/schemas.js";
import { validateCourtReading } from "../contract/validation.js";
import type { Platform, TenantConfig } from "../contract/types.js";
import { parseLocalDate } from "../runtime/temporal.js";
import { parseArgs, singleOption } from "./args.js";
import { configFiles, loadConfig, validatePlatformConfig } from "./config.js";
import { replayFixtures, startFixtureServer } from "./fixtures.js";
import {
  createCliGate,
  formatReading,
  parseReadOptions,
  readCourt,
} from "./read.js";
import {
  preflightRecordingDestination,
  writeLiveReport,
  writeRecording,
} from "./record.js";
import { conformanceFixturePath, listPlatforms } from "./registry.js";
import { CliExit, type CliIO, type ReadOptions } from "./types.js";

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
    "  courttide-connectors test:live --config <dir> [--platform <id>] [--courts <key,...>] [--date YYYY-MM-DD] [--days N]",
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
  preflightRecordingDestination(io.cwd, name);
  const execution = createCliGate(10_000);
  execution.captureResponses = true;
  const result = await readCourt(options, io, execution);
  const path = await writeRecording(
    io.cwd,
    name,
    result,
    io.now?.() ?? new Date(),
    options.config,
  );
  io.stdout(`Verified local recording written: ${path}`);
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
    if (!platform) throw new Error(`Unsupported platform: ${tenant.platform}`);
    validatePlatformConfig(tenant, platform);
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
  const parsed = parseArgs(args, [
    "config",
    "platform",
    "courts",
    "base-url",
    "date",
    "days",
  ]);
  if (parsed.positional.length)
    throw new Error("test:live accepts only options");
  if (io.ci ?? Boolean(process.env.CI)) {
    io.stderr("test:live is disabled in CI; no configured source was read.");
    throw new CliExit(3);
  }
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
  const dateOption = singleOption(parsed.values, "date");
  const selectedDate = dateOption
    ? parseLocalDate(dateOption).toString()
    : undefined;
  const daysText = singleOption(parsed.values, "days");
  if (daysText !== undefined && !/^\d+$/.test(daysText))
    throw new Error("--days must be a positive integer");
  const requestedDays = daysText === undefined ? 1 : Number(daysText);
  if (!Number.isSafeInteger(requestedDays) || requestedDays < 1)
    throw new Error("--days must be a positive integer");
  const files = configFiles(configPath, io.cwd);
  if (!files.length) throw new Error("No tenant configs found");
  const targets: {
    options: ReadOptions;
    tenant: TenantConfig;
    platform: Platform;
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
          date:
            selectedDate ??
            localDate(io.now?.() ?? new Date(), tenant.timeZone),
          days: Math.min(requestedDays, capabilities.maxDaysPerRead),
          json: false,
          ...(baseUrl ? { baseUrl } : {}),
        },
        tenant,
        platform,
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
    Math.max(
      ...targets.map(
        (target) =>
          validatePlatformConfig(target.tenant, target.platform).minimumGapMs,
      ),
    ),
  );
  const counts = {
    selected: targets.length,
    passed: 0,
    parseFailures: 0,
    inconclusive: 0,
    blocked: 0,
  };
  let exitCode: 0 | 1 | 2 | 3 = 0;
  for (const target of targets) {
    try {
      const result = await readCourt(target.options, io, execution);
      const park = target.tenant.parks.find((item) =>
        item.courts.some((court) => court.key === target.options.court),
      );
      const reading = validateCourtReading(result.reading, {
        shape: target.platform.capabilities(target.tenant).shape,
        timeZone: target.tenant.timeZone,
        parkSlug: park?.courttideSlug,
      });
      const allowedStatuses =
        target.platform.id === "activenet"
          ? new Set([0, 1, 2, 4, 7])
          : new Set([200]);
      const allowedReasons = new Set([
        "date_coverage_incomplete",
        "date_out_of_range",
        "date_mismatch",
        "display_hours_conflict",
        "display_hours_missing_or_invalid",
        "duplicate_source_date",
        "empty_display_hours",
        "empty_hours",
        "epoch_local_mismatch",
        "hours_missing_or_invalid",
        "invalid_epoch",
        "invalid_local_time",
        "invalid_payload",
        "invalid_range_shape",
        "invalid_request_context",
        "invalid_signal",
        "lit_operation_unknown",
        "nonpositive_range",
        "rate_mismatch",
        "range_limit_exceeded",
        "text_limit_exceeded",
        "unsupported_cross_date_range",
        "occupancy_unknown",
        "range_incomplete",
        "reported_ranges_only",
        "source_closes_at_midnight",
        "source_fully_booked",
        "source_hidden_or_unavailable",
        "source_schedule_closed",
        "unknown_source_status",
        "unsupported_check_mode",
        "unsupported_time",
      ]);
      if (
        reading.days.some(
          (day) =>
            !allowedStatuses.has(day.status) ||
            day.reasonCodes.some((reason) => !allowedReasons.has(reason)),
        )
      ) {
        counts.parseFailures += 1;
        exitCode = 1;
        break;
      }
      counts.passed += 1;
    } catch (error) {
      const code =
        error && typeof error === "object" && "code" in error
          ? String(error.code)
          : "";
      const lastRelease = [...execution.gateLog]
        .reverse()
        .find((entry) => entry.type === "release") as
        { outcome?: { status?: number } } | undefined;
      const httpStatus = lastRelease?.outcome?.status;
      if (code === "access_blocked" || code === "auth_required") {
        counts.blocked += 1;
        exitCode = 3;
      } else if (
        code === "rate_limited" ||
        (httpStatus !== undefined && httpStatus >= 500) ||
        (code === "http_error" &&
          error &&
          typeof error === "object" &&
          "retryable" in error &&
          error.retryable === true) ||
        (httpStatus === undefined && code === "http_error") ||
        (error instanceof Error && error.name === "GateDeferred")
      ) {
        counts.inconclusive += 1;
        exitCode = 2;
      } else {
        counts.parseFailures += 1;
        exitCode = 1;
      }
      break;
    }
  }
  writeLiveReport(io.cwd, {
    generatedAt: (io.now?.() ?? new Date()).toISOString(),
    ...counts,
    exitCode,
  });
  io.stdout(
    `Live test counts: selected=${counts.selected} passed=${counts.passed} parseFailures=${counts.parseFailures} inconclusive=${counts.inconclusive} blocked=${counts.blocked}\n${creditLine}`,
  );
  if (exitCode !== 0) throw new CliExit(exitCode);
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
