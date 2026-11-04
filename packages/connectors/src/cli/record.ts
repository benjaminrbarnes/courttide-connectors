import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
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
): string {
  const root = repositoryRoot(cwd);
  const directory = resolve(root, "local", "recordings", safeName(name));
  const target = resolve(directory, "record.json");
  assertIgnoredLocalPath(root, target);
  const reading = result.reading;
  const payload = {
    schemaVersion: "1",
    source: "recorded",
    recordedAt: recordedAt.toISOString(),
    redactions: [
      "request header values are omitted",
      "original response body is omitted; adapter-sanitized payload is retained",
      "read source URL is omitted",
      "sensitive query parameter values are redacted",
    ],
    requestLog: result.requestLog,
    gateLog: result.gateLog,
    reading: {
      platform: reading.platform,
      tenant: reading.tenant,
      court: reading.court,
      startDate: reading.startDate,
      endDate: reading.endDate,
      complete: reading.complete,
      observedAt: reading.observedAt,
      days: reading.days,
      sanitizedPayload: reading.sanitized,
      parser: reading.parser,
      attribution: reading.attribution,
    },
  };
  try {
    writeFileSync(target, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new Error("A recording with that case name already exists");
    throw error;
  }
  return target;
}
