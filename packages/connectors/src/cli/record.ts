import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  renameSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HttpResponse } from "../contract/types.js";
import {
  bootstrapAttributes,
  parseAnonymousBootstrap,
} from "../runtime/bootstrap.js";
import { replayFixtures } from "./fixtures.js";
import type { ReadResult } from "./read.js";

const SYNTHETIC_KEY = "synthetic-session-key";
const SYNTHETIC_COOKIE_PREFIX = "synthetic-session-cookie-";

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
    if (result.reading.platform === "civicrec") {
      if (day.visibility === "hidden_or_unavailable") cases.add("hidden_day");
      else if (day.intervals.length > 1) {
        const ordered = [...day.intervals].sort((a, b) =>
          a.start.localeCompare(b.start),
        );
        if (
          ordered.some(
            (interval, index) =>
              index > 0 && interval.start > ordered[index - 1]!.end,
          )
        )
          cases.add("gap");
        else if (
          ordered.some(
            (interval, index) =>
              index > 0 && interval.start === ordered[index - 1]!.end,
          )
        )
          cases.add("touching_intervals");
        else cases.add("open_interval");
      } else cases.add("open_interval");
      continue;
    }
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

function assertIgnoredLocalPath(
  root: string,
  target: string,
  createMissing = true,
): void {
  const local = resolve(root, "local");
  if (!within(local, target) || target.split(sep).includes("fixtures"))
    throw new Error(
      "Recordings may be written only under the ignored local/ directory",
    );
  const directory = resolve(target, "..");
  const relativeDirectory = relative(local, directory);
  const segments = relativeDirectory.split(sep).filter(Boolean);
  const walk = (createMissing: boolean) => {
    let localStats;
    try {
      localStats = lstatSync(local);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (
      localStats?.isSymbolicLink() ||
      (localStats && !localStats.isDirectory())
    )
      throw new Error("Recordings require a regular local/ directory");
    if (!localStats) {
      if (!createMissing) return;
      mkdirSync(local);
    }
    const realLocal = realpathSync(local);
    let current = local;
    for (const segment of segments) {
      current = resolve(current, segment);
      let stats;
      try {
        stats = lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!stats) {
        if (!createMissing) return;
        mkdirSync(current);
      } else if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(
          "Recording path contains a symbolic link or non-directory",
        );
      }
      const realCurrent = realpathSync(current);
      if (
        !within(realLocal, realCurrent) ||
        realCurrent.split(sep).includes("fixtures")
      )
        throw new Error("Recordings may not resolve inside fixtures/");
    }
  };
  walk(false);
  const relativePath = relative(root, target);
  try {
    execFileSync("git", ["check-ignore", "--quiet", relativePath], {
      cwd: root,
      stdio: "ignore",
    });
  } catch {
    throw new Error("The local recording path is not git-ignored");
  }
  if (createMissing) walk(true);
  if (isAbsolute(relativePath)) throw new Error("Invalid local recording path");
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function firstOpeningTag(html: string): string {
  let cursor = 0;
  while ((cursor = html.indexOf("<", cursor)) >= 0) {
    if (html.startsWith("<!--", cursor)) {
      const commentEnd = html.indexOf("-->", cursor + 4);
      if (commentEnd < 0) throw new Error("Unclosed bootstrap comment");
      cursor = commentEnd + 3;
      continue;
    }
    let quote = "";
    let end = cursor + 1;
    for (; end < html.length; end += 1) {
      const char = html[end]!;
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === "'" || char === '"') quote = char;
      else if (char === ">") break;
    }
    if (end >= html.length) throw new Error("Invalid bootstrap element");
    const tag = html.slice(cursor, end + 1);
    if (
      /^<[a-z][a-z0-9:-]*/i.test(tag) &&
      /(?:^|\s)data-page-data\s*=/i.test(tag.slice(1, -1)) &&
      /(?:^|\s)data-base-path\s*=/i.test(tag.slice(1, -1))
    )
      return tag;
    cursor = end + 1;
  }
  throw new Error("Bootstrap element is missing");
}

interface RawAttribute {
  name: string;
  spacing: string;
  quote: "'" | '"';
  value: string;
}

function rawAttribute(tag: string, name: string): RawAttribute {
  const content = tag.slice(1, tag.lastIndexOf(">"));
  const match = new RegExp(
    `(^|\\s)(${name})(\\s*=\\s*)(["'])([\\s\\S]*?)\\4`,
    "i",
  ).exec(content);
  if (!match) throw new Error(`Bootstrap ${name} attribute is missing`);
  return {
    name: match[2]!,
    spacing: match[3]!,
    quote: match[4] as "'" | '"',
    value: match[5]!,
  };
}

function encodeAttribute(value: string, quote: "'" | '"'): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(quote === "'" ? /'/g : /"/g, quote === "'" ? "&#39;" : "&quot;");
}

function scrubBootstrapHtml(html: string, actualKey: string): string {
  const attributes = bootstrapAttributes(html);
  let page: unknown;
  try {
    page = JSON.parse(attributes.page);
  } catch {
    throw new Error("Bootstrap page data could not be parsed for redaction");
  }
  if (!object(page) || !object(page.checkoutData))
    throw new Error("Bootstrap checkout data could not be redacted safely");
  const checkout = page.checkoutData;
  if (
    checkout.key !== actualKey ||
    (checkout.user !== null && checkout.user !== false)
  )
    throw new Error(
      "Bootstrap contains unsupported or non-anonymous page data",
    );
  const tag = firstOpeningTag(html);
  const tagName = /^<([a-z][a-z0-9:-]*)/i.exec(tag)?.[1];
  if (!tagName) throw new Error("Bootstrap element name is invalid");
  const pageAttribute = rawAttribute(tag, "data-page-data");
  const baseAttribute = rawAttribute(tag, "data-base-path");
  const pageData = JSON.stringify({
    checkoutData: { user: checkout.user, key: SYNTHETIC_KEY },
  });
  const attributesText =
    `${pageAttribute.name}${pageAttribute.spacing}${pageAttribute.quote}` +
    `${encodeAttribute(pageData, pageAttribute.quote)}${pageAttribute.quote} ` +
    `${baseAttribute.name}${baseAttribute.spacing}${baseAttribute.quote}` +
    `${baseAttribute.value}${baseAttribute.quote}`;
  const selfClosing = /\/\s*>$/.test(tag);
  return selfClosing
    ? `<${tagName} ${attributesText} />`
    : `<${tagName} ${attributesText}></${tagName}>`;
}

function scrubSetCookieHeaders(
  response: HttpResponse,
  actualCookie: string,
): { rows: string[]; requestCookie: string; secretValues: string[] } {
  const originalRows = response.headers.getSetCookie();
  if (!originalRows.length || originalRows.length > 16)
    throw new Error("Bootstrap session cookie headers are not supported");
  const replacements = new Map<string, string>();
  const rows = originalRows.map((row, index) => {
    const [pair, ...attributes] = row.split(";");
    const equals = pair!.indexOf("=");
    if (equals < 1) throw new Error("Bootstrap cookie header is malformed");
    const name = pair!.slice(0, equals).trim();
    const replacement = `${SYNTHETIC_COOKIE_PREFIX}${index}`;
    if (replacements.has(name))
      throw new Error("Duplicate bootstrap cookie name");
    replacements.set(name, replacement);
    return `${name}=${replacement}${attributes.map((item) => `;${item}`).join("")}`;
  });
  const requestCookie = actualCookie
    .split(/;\s*/)
    .map((pair) => pair.slice(0, pair.indexOf("=")).trim())
    .map((name) => {
      const replacement = replacements.get(name);
      if (!replacement)
        throw new Error("Bootstrap cookie could not be replaced");
      return `${name}=${replacement}`;
    })
    .join("; ");
  return {
    rows,
    requestCookie,
    secretValues: [...replacements.values()],
  };
}

function replaceKeyInUrl(value: string, actualKey: string): string {
  const url = new URL(value);
  const segments = url.pathname.split("/");
  const matches = segments
    .map((segment, index) => {
      try {
        return decodeURIComponent(segment) === actualKey ? index : -1;
      } catch {
        return -1;
      }
    })
    .filter((index) => index >= 0);
  if (matches.length !== 1)
    throw new Error("CivicRec calendar URL did not contain one bootstrap key");
  segments[matches[0]!] = encodeURIComponent(SYNTHETIC_KEY);
  url.pathname = segments.join("/");
  return url.href;
}

function safeRange(value: unknown): Record<string, unknown> {
  if (!object(value)) return {};
  if (!object(value.rateType)) return {};
  const range: Record<string, unknown> = {};
  for (const field of ["start", "end"]) {
    if (typeof value[field] === "number") range[field] = value[field];
    else if (field in value) range[field] = "[redacted-invalid-value]";
  }
  for (const field of ["startDtm", "endDtm"]) {
    if (
      typeof value[field] === "string" &&
      /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/.test(
        value[field],
      )
    )
      range[field] = value[field];
    else if (field in value) range[field] = "[redacted-invalid-value]";
  }
  for (const field of ["fragment", "block"]) {
    if (typeof value[field] === "boolean") range[field] = value[field];
    else if (field in value) range[field] = null;
  }
  const id = value.rateType.id;
  range.rateType = {
    id:
      (typeof id === "number" && Number.isSafeInteger(id) && id > 0) ||
      (typeof id === "string" && /^[1-9]\d{0,31}$/.test(id))
        ? id
        : "invalid",
  };
  if (
    value.minDaysOutOverridden === null ||
    typeof value.minDaysOutOverridden === "boolean"
  )
    range.minDaysOutOverridden = value.minDaysOutOverridden;
  else if (value.minDaysOutOverridden !== undefined)
    range.minDaysOutOverridden = "[redacted-invalid-value]";
  return range;
}

function safeCalendarPayload(text: string): string {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error("Calendar response could not be parsed for safe recording");
  }
  if (!object(payload)) throw new Error("Calendar response is not an object");
  const safe = {
    hours: Array.isArray(payload.hours)
      ? payload.hours.slice(0, 256).map(safeRange)
      : null,
    displayHours: Array.isArray(payload.displayHours)
      ? payload.displayHours.slice(0, 256).map(safeRange)
      : null,
    availableForRate:
      typeof payload.availableForRate === "boolean"
        ? payload.availableForRate
        : null,
  };
  if (
    (Array.isArray(payload.hours) && payload.hours.length > 256) ||
    (Array.isArray(payload.displayHours) && payload.displayHours.length > 256)
  )
    throw new Error("Calendar response exceeds the supported range count");
  return JSON.stringify(safe);
}

function responseFixture(
  response: HttpResponse,
  body: string,
  setCookies: readonly string[] = [],
): Record<string, unknown> {
  const contentType = response.headers.get("content-type");
  if (!contentType)
    throw new Error("Recorded response content type is missing");
  const headers: [string, string][] = [["content-type", contentType]];
  for (const cookie of setCookies) headers.push(["set-cookie", cookie]);
  return { status: response.status, headers, body };
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
}

function sanitizedFiles(
  cwd: string,
  configPath: string,
  result: ReadResult,
  recordedAt: Date,
): Record<string, unknown> {
  const reading = result.reading;
  const requests = jsonClone(result.requestLog) as {
    url: string;
    init: { headers: Record<string, string> };
  }[];
  const gate = jsonClone(result.gateLog) as {
    type: string;
    request?: { url?: string; purpose?: string };
  }[];
  const captured = result.responses;
  const secretValues: string[] = [];
  const redactions: string[] = [];
  const inventedFields: string[] = [];
  let responses: Record<string, unknown>[];

  if (reading.platform === "activenet") {
    if (captured.length !== 1 || requests.length !== 1)
      throw new Error("A recording must contain exactly one bounded response");
    const response = captured[0]!.response;
    if (response.status !== 200)
      throw new Error("Only successful 200 responses can be recorded");
    const details = reading.sanitized;
    if (!object(details))
      throw new Error("The adapter did not provide a safe normalized payload");
    let responseCode: unknown;
    try {
      const source = JSON.parse(response.text) as {
        headers?: { response_code?: unknown };
      };
      responseCode = source.headers?.response_code;
    } catch {
      throw new Error("The ActiveNet response wrapper could not be verified");
    }
    if (responseCode !== "0000" && responseCode !== "0001")
      throw new Error("The ActiveNet response did not contain a success code");
    responses = [
      responseFixture(
        response,
        JSON.stringify({
          headers: { response_code: responseCode },
          body: { details },
        }),
      ),
    ];
    redactions.push(
      "Original ActiveNet response body replaced with the adapter normalized details; unknown fields were omitted.",
      "Response headers other than Content-Type were omitted.",
    );
    inventedFields.push(
      `Response envelope rebuilt from normalized details; captured response_code ${responseCode} was retained.`,
    );
  } else if (reading.platform === "civicrec") {
    if (
      captured.length < 2 ||
      captured.length > 3 ||
      requests.length !== captured.length ||
      captured[0]!.request.purpose !== "bootstrap" ||
      captured.slice(1).some((item) => item.request.purpose !== "calendar") ||
      captured.length !== reading.days.length + 1
    )
      throw new Error(
        "CivicRec recording requires one bootstrap and one response per bounded day",
      );
    const bootstrapCapture = captured[0]!;
    const bootstrapUrl = bootstrapCapture.request.url;
    const bootstrap = parseAnonymousBootstrap({
      html: bootstrapCapture.response.text,
      headers: bootstrapCapture.response.headers,
      catalogUrl: bootstrapUrl,
      receivedAt: bootstrapCapture.response.receivedAt,
      cookieDomains: ["secure.rec1.com", "rec1.com"],
    });
    if (bootstrap.key.length < 8)
      throw new Error(
        "Bootstrap key is too short for safe recording redaction",
      );
    const cookies = scrubSetCookieHeaders(
      bootstrapCapture.response,
      bootstrap.cookie,
    );
    secretValues.push(SYNTHETIC_KEY, ...cookies.secretValues);
    const bootstrapHtml = scrubBootstrapHtml(
      bootstrapCapture.response.text,
      bootstrap.key,
    );
    responses = [
      responseFixture(bootstrapCapture.response, bootstrapHtml, cookies.rows),
    ];
    for (const [index, calendarCapture] of captured.slice(1).entries()) {
      const requestIndex = index + 1;
      requests[requestIndex]!.url = replaceKeyInUrl(
        requests[requestIndex]!.url,
        bootstrap.key,
      );
      const calendarCookie = requests[requestIndex]!.init.headers.cookie;
      if (calendarCookie !== bootstrap.cookie)
        throw new Error(
          "Recorded calendar cookie did not match the bootstrap jar",
        );
      requests[requestIndex]!.init.headers.cookie = cookies.requestCookie;
      responses.push(
        responseFixture(
          calendarCapture.response,
          safeCalendarPayload(calendarCapture.response.text),
        ),
      );
    }
    for (const entry of gate) {
      if (
        entry.type === "acquire" &&
        entry.request?.purpose === "calendar" &&
        entry.request.url
      )
        entry.request.url = replaceKeyInUrl(entry.request.url, bootstrap.key);
    }
    redactions.push(
      "Bootstrap checkout key replaced in the page-data attribute and its follow-up calendar URL.",
      "Set-Cookie values replaced with synthetic values in the bootstrap response and follow-up Cookie header.",
      "Catalog HTML outside the bootstrap element and page-data fields other than anonymous user/key were omitted.",
      "Calendar descriptions, info, availableTimeDisplay, and unrecognized fields were omitted.",
      "Response headers other than Content-Type and sanitized Set-Cookie rows were omitted.",
    );
    inventedFields.push(
      `Synthetic bootstrap key ${SYNTHETIC_KEY} substituted for the captured transient key.`,
      "Synthetic cookie values substituted for captured session cookie values; cookie names and attributes were retained.",
      "A minimal bootstrap element containing only parser-required attributes was reconstructed using the recorded element name and quote style.",
    );
  } else {
    throw new Error(
      `Recording is unsupported for platform ${reading.platform}`,
    );
  }

  if (captured.some((item) => item.response.status !== 200))
    throw new Error("Only successful 200 responses can be recorded");
  const meta: Record<string, unknown> = {
    source: "recorded",
    cases: conformanceCases(result),
    clockNow: reading.observedAt,
    clockSequence: [
      ...captured.map((item) => item.response.receivedAt),
      reading.observedAt,
    ],
    configPath: resolve(cwd, configPath),
    court: reading.court,
    range: { start: reading.startDate, end: reading.endDate },
    operation: "readCourt",
    redactions,
    inventedFields,
    recordedAt: recordedAt.toISOString(),
  };
  if (secretValues.length) {
    meta.secrets = secretValues;
  }
  const files = {
    "meta.json": meta,
    "requests.json": requests,
    "responses.json": responses,
    "gate.json": gate,
    "expected.json": reading,
  };
  const serialized = JSON.stringify(files);
  const capturedSecrets = new Set<string>();
  const bootstrapKey = bootstrapSecretFrom(captured);
  if (bootstrapKey) capturedSecrets.add(bootstrapKey);
  for (const item of captured) {
    for (const cookie of item.response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0]!;
      const separator = pair.indexOf("=");
      if (separator >= 0)
        capturedSecrets.add(
          pair
            .slice(separator + 1)
            .trim()
            .replace(/^"|"$/g, ""),
        );
    }
    const cookie = item.request.headers?.cookie;
    if (cookie)
      for (const pair of cookie.split(/;\s*/)) {
        const separator = pair.indexOf("=");
        if (separator >= 0)
          capturedSecrets.add(
            pair
              .slice(separator + 1)
              .trim()
              .replace(/^"|"$/g, ""),
          );
      }
  }
  for (const secret of capturedSecrets)
    if (secret.length >= 8 && serialized.includes(secret))
      throw new Error(
        "Sanitized fixture still contains captured secret material",
      );
  return files;
}

function bootstrapSecretFrom(captured: ReadResult["responses"]): string {
  const item = captured.find((entry) => entry.request.purpose === "bootstrap");
  if (!item) return "";
  try {
    const attrs = bootstrapAttributes(item.response.text);
    const page = JSON.parse(attrs.page) as {
      checkoutData?: { key?: unknown };
    };
    return typeof page.checkoutData?.key === "string"
      ? page.checkoutData.key
      : "";
  } catch {
    return "";
  }
}

export function preflightRecordingDestination(
  cwd: string,
  name: string,
): string {
  const root = repositoryRoot(cwd);
  const recordingName = safeName(name);
  const parent = resolve(root, "local", "recordings");
  const directory = resolve(parent, recordingName);
  const finalMeta = resolve(directory, "meta.json");
  assertIgnoredLocalPath(root, finalMeta, false);
  if (existsSync(directory))
    throw new Error(
      "A recording with that case name already exists before capture",
    );
  return directory;
}

export async function writeRecording(
  cwd: string,
  name: string,
  result: ReadResult,
  recordedAt: Date,
  configPath: string,
): Promise<string> {
  const directory = preflightRecordingDestination(cwd, name);
  const root = repositoryRoot(cwd);
  const parent = resolve(directory, "..");
  const recordingName = basename(directory);
  assertIgnoredLocalPath(root, resolve(parent, ".recording-parent-check"));
  const staging = resolve(parent, `.stage-${recordingName}-${randomUUID()}`);
  assertIgnoredLocalPath(root, join(staging, "meta.json"));
  try {
    const files = sanitizedFiles(cwd, configPath, result, recordedAt);
    for (const [filename, value] of Object.entries(files))
      writeJson(join(staging, filename), value);
    await replayFixtures(staging);
    preflightRecordingDestination(cwd, name);
    assertIgnoredLocalPath(root, join(staging, "meta.json"), false);
    if (existsSync(directory))
      throw new Error("A recording case path appeared during verification");
    renameSync(staging, directory);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
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
