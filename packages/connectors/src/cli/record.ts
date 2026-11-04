import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ReadResult } from "./read.js";

function safeName(value: string): string {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))
    throw new Error(
      "--case must be a short lowercase name using letters, digits and hyphens",
    );
  return value;
}

function within(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== "..");
}

function conformanceCases(result: ReadResult): string[] {
  const cases = new Set<string>();
  for (const day of result.reading.days) {
    if (day.reasonCodes.includes("source_closes_at_midnight")) {
      cases.add("midnight_end");
    } else if (day.status === 2) {
      cases.add("whole_day_closed");
    } else if (day.status === 4) {
      cases.add("whole_day_booked");
    } else if (day.status === 7) {
      cases.add("hidden_day");
    } else if (![0, 1].includes(day.status)) {
      cases.add("unknown_status");
    } else if (day.intervals.length) {
      cases.add("open_interval");
    } else {
      cases.add("gap");
    }
  }
  if (!cases.size) throw new Error("A recording needs at least one parsed day");
  return [...cases];
}

function repositoryRoot(cwd: string): string {
  try {
    return realpathSync(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
  } catch {
    throw new Error(
      "Recordings require a git checkout with an ignored local/ folder",
    );
  }
}

function assertIgnoredLocalPath(root: string, target: string): void {
  const local = resolve(root, "local");
  if (!within(local, target) || target.split(sep).includes("fixtures"))
    throw new Error(
      "Recordings may be written only under the ignored local/ directory",
    );
  try {
    const stats = lstatSync(local);
    if (stats.isSymbolicLink() || !stats.isDirectory())
      throw new Error("Recordings require a regular local/ directory");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(resolve(target, ".."), { recursive: true });
  const relativePath = relative(root, target);
  try {
    execFileSync("git", ["check-ignore", "--quiet", relativePath], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    throw new Error("The local recording path is not git-ignored");
  }
  const expectedLocal = resolve(root, "local");
  const realLocal = realpathSync(local);
  const realTarget = realpathSync(resolve(target, ".."));
  if (
    realLocal !== expectedLocal ||
    !within(root, realTarget) ||
    realTarget.split(sep).includes("fixtures")
  )
    throw new Error("Recordings may not resolve inside fixtures/");
  if (isAbsolute(relativePath)) throw new Error("Invalid local recording path");
}

export function writeRecording(
  cwd: string,
  name: string,
  result: ReadResult,
  recordedAt: Date,
  configPath: string,
): string {
  const root = repositoryRoot(cwd);
  const directory = resolve(root, "local", "recordings", safeName(name));
  const target = resolve(directory, "meta.json");
  if (existsSync(directory))
    throw new Error("A recording with that case name already exists");
  assertIgnoredLocalPath(root, target);
  if (result.reading.platform !== "activenet")
    throw new Error(
      "record currently supports ActiveNet only; CivicRec requires bootstrap secret replacement verification",
    );
  if (result.responses.length !== 1 || result.requestLog.length !== 1)
    throw new Error("A recording must contain exactly one bounded response");
  const reading = result.reading;
  const captured = result.responses[0]!;
  if (captured.response.status !== 200)
    throw new Error("Only successful 200 responses can be recorded");
  const details = reading.sanitized;
  if (!details || typeof details !== "object" || Array.isArray(details))
    throw new Error("The adapter did not provide a safe normalized payload");
  let responseCode: unknown;
  try {
    const source = JSON.parse(captured.response.text) as {
      headers?: { response_code?: unknown };
    };
    responseCode = source.headers?.response_code;
  } catch {
    throw new Error("The ActiveNet response wrapper could not be verified");
  }
  if (responseCode !== "0000" && responseCode !== "0001")
    throw new Error("The ActiveNet response did not contain a success code");
  const responseBody = JSON.stringify({
    headers: { response_code: responseCode },
    body: { details },
  });
  const fixtureFiles: Record<string, unknown> = {
    "meta.json": {
      source: "recorded",
      cases: conformanceCases(result),
      clockNow: reading.observedAt,
      configPath: resolve(cwd, configPath),
      court: reading.court,
      range: { start: reading.startDate, end: reading.endDate },
      operation: "readCourt",
      redactions: ["response body rebuilt from the adapter normalized payload"],
      inventedFields: [
        "ActiveNet success wrapper response_code 0000 was supplied to replay the normalized details.",
      ],
      recordedAt: recordedAt.toISOString(),
    },
    "requests.json": result.requestLog,
    "responses.json": [
      {
        status: captured.response.status,
        headers: { "content-type": "application/json" },
        body: responseBody,
      },
    ],
    "gate.json": result.gateLog,
    "expected.json": reading,
  };
  const created: string[] = [];
  try {
    for (const [filename, value] of Object.entries(fixtureFiles)) {
      const file = resolve(directory, filename);
      writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      created.push(file);
    }
  } catch (error) {
    for (const file of created) unlinkSync(file);
    try {
      rmdirSync(directory);
    } catch {
      // Preserve a concurrently created path rather than removing unknown data.
    }
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("A recording with that case name already exists");
    throw error;
  }
  return directory;
}

export function writeLiveReport(
  cwd: string,
  report: {
    generatedAt: string;
    selected: number;
    passed: number;
    parseFailures: number;
    inconclusive: number;
    blocked: number;
    exitCode: number;
  },
): string {
  const root = repositoryRoot(cwd);
  const target = resolve(root, "local", "live-report.json");
  assertIgnoredLocalPath(root, target);
  writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return target;
}
