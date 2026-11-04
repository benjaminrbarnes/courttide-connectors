import { ATTRIBUTION } from "../contract/constants.js";
import { ConnectorError } from "../contract/errors.js";
import { isIP } from "node:net";
import type {
  CourtReading,
  Gate,
  GateOutcome,
  GateRequest,
  HttpRequest,
  HttpResponse,
  HttpClient,
  TenantConfig,
} from "../contract/types.js";
import { createConnectorRuntime } from "../runtime/http.js";
import { politeGate } from "../runtime/polite-gate.js";
import { parseLocalDate } from "../runtime/temporal.js";
import { loadConfig, validatePlatformConfig } from "./config.js";
import { getPlatform } from "./registry.js";
import type { CliIO, ParsedArgs, ReadOptions } from "./types.js";
import { singleOption } from "./args.js";

export interface ReadResult {
  reading: CourtReading;
  requestLog: Record<string, unknown>[];
  gateLog: Record<string, unknown>[];
  responses: { request: HttpRequest; response: HttpResponse }[];
}

export interface ReadExecution {
  gate: Gate;
  requestLog: Record<string, unknown>[];
  gateLog: Record<string, unknown>[];
  captureResponses?: boolean;
  responses: { request: HttpRequest; response: HttpResponse }[];
}

const unsafeParam =
  /(?:auth|cookie|csrf|member|password|secret|session|token)/i;

export function requireLoopbackBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Test base URL must be an HTTP loopback origin");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const ipv4Loopback = isIP(host) === 4 && host.startsWith("127.");
  if (
    url.protocol !== "http:" ||
    !(ipv4Loopback || (isIP(host) === 6 && host === "::1")) ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "Test base URL must be an HTTP loopback origin with a port",
    );
  }
  return url;
}

export function sanitizedUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of url.searchParams.keys())
      if (unsafeParam.test(key)) url.searchParams.set(key, "[redacted]");
    url.pathname = url.pathname
      .replace(/(\/catalog\/getFacilityHours\/)[^/]+/i, "$1[redacted]")
      .replace(
        /(\/catalog\/getFacilityHours\/[^/]+\/)\d+(\/)\d+(\/)/i,
        "$1[facility]$2[rate]$3",
      )
      .replace(
        /(\/availability\/daily\/|\/detail\/)\d{1,10}(?=\/|$)/i,
        "$1[resource]",
      );
    return url.href;
  } catch {
    return "[invalid-url]";
  }
}

function makeFetch(
  io: CliIO,
  baseUrl: URL | undefined,
  requestLog: Record<string, unknown>[],
): typeof fetch {
  const transport = io.fetch ?? globalThis.fetch;
  return async (input, init) => {
    const sourceUrl = input instanceof Request ? input.url : String(input);
    const method =
      init?.method ?? (input instanceof Request ? input.method : "GET");
    const rawHeaders = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const loggedHeaders =
      init?.headers &&
      typeof init.headers === "object" &&
      !Array.isArray(init.headers)
        ? { ...(init.headers as Record<string, string>) }
        : Object.fromEntries(rawHeaders.entries());
    const loggedInit: Record<string, unknown> = {
      method: method.toUpperCase(),
      headers: loggedHeaders,
      credentials: init?.credentials ?? "omit",
      redirect: init?.redirect ?? "manual",
      cache: init?.cache ?? "no-store",
      signal: init?.signal ? "present" : null,
    };
    if (init?.body !== undefined) loggedInit.body = init.body;
    requestLog.push({ url: sourceUrl, init: loggedInit });
    if (!baseUrl) return transport(input, init);
    const target = new URL(sourceUrl);
    target.protocol = baseUrl.protocol;
    target.host = baseUrl.host;
    target.username = "";
    target.password = "";
    if (input instanceof Request)
      return transport(new Request(target, input), init);
    return transport(target, init);
  };
}

export function createCliGate(minimumGapMs: number): ReadExecution {
  const calls: Record<string, unknown>[] = [];
  const gate = politeGate({ minimumGapMs: Math.max(10_000, minimumGapMs) });
  let index = 0;
  const tickets = new WeakMap<object, number>();
  const recording: Gate = {
    async acquire(request: GateRequest) {
      calls.push({
        type: "acquire",
        request: { ...request },
      });
      const ticket = await gate.acquire(request);
      const id = ++index;
      tickets.set(ticket as object, id);
      return ticket;
    },
    async release(ticket: unknown, outcome: GateOutcome) {
      const id =
        ticket && typeof ticket === "object" ? tickets.get(ticket) : undefined;
      if (id === undefined) throw new Error("Unknown gate ticket");
      calls.push({ type: "release", ticket: id, outcome: { ...outcome } });
      await gate.release(ticket, outcome);
    },
  };
  return { gate: recording, requestLog: [], gateLog: calls, responses: [] };
}

function findCourt(tenant: TenantConfig, key: string) {
  const matches = tenant.parks.filter((park) =>
    park.courts.some((court) => court.key === key),
  );
  if (matches.length !== 1)
    throw new Error("Court is missing or duplicated in config");
  const court = matches[0]!.courts.find((item) => item.key === key)!;
  return { park: matches[0]!, court };
}

export function parseReadOptions(parsed: ParsedArgs): ReadOptions {
  if (parsed.positional.length !== 1)
    throw new Error(
      "Usage: read <platform> --config <file> --court <key> --date YYYY-MM-DD [--days N] --live [--json]",
    );
  if ((parsed.values.get("court") ?? []).length > 1)
    throw new Error(
      "read accepts one court only; CourtTide's public MCP for many parks is planned",
    );
  const platform = parsed.positional[0]!;
  const config = singleOption(parsed.values, "config", true)!;
  const court = singleOption(parsed.values, "court", true)!;
  if (court.includes(","))
    throw new Error(
      "read accepts one court only; CourtTide's public MCP for many parks is planned",
    );
  const date = singleOption(parsed.values, "date", true)!;
  const daysText = singleOption(parsed.values, "days");
  const baseUrl = singleOption(parsed.values, "base-url");
  if (!parsed.flags.has("live")) throw new Error("Live reads require --live");
  if (baseUrl) requireLoopbackBaseUrl(baseUrl);
  if (daysText && !/^\d+$/.test(daysText))
    throw new Error("--days must be a positive integer");
  const days = daysText ? Number(daysText) : 1;
  if (!Number.isSafeInteger(days) || days < 1)
    throw new Error("--days must be a positive integer");
  return {
    platform,
    config,
    court,
    date,
    days,
    json: parsed.flags.has("json"),
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export async function readCourt(
  options: ReadOptions,
  io: CliIO,
  shared?: ReadExecution,
): Promise<ReadResult> {
  const platform = getPlatform(options.platform);
  const tenant = loadConfig(options.config, io.cwd);
  const capabilities = validatePlatformConfig(tenant, platform);
  const { park } = findCourt(tenant, options.court);
  const start = parseLocalDate(options.date);
  const days = Math.min(options.days, capabilities.maxDaysPerRead);
  if (days < options.days)
    io.stderr(
      `Requested span capped at ${capabilities.maxDaysPerRead} days for this platform.`,
    );
  const end = start.add({ days: days - 1 }).toString();
  const execution = shared ?? createCliGate(capabilities.minimumGapMs);
  const requestLog = execution.requestLog;
  const gateLog = execution.gateLog;
  const runtime = createConnectorRuntime({
    tenant,
    profile: platform.transport,
    leaseScope: capabilities.leaseScope,
    gate: execution.gate,
    fetch: makeFetch(
      io,
      options.baseUrl ? requireLoopbackBaseUrl(options.baseUrl) : undefined,
      requestLog,
    ),
    now: io.now ?? (() => new Date()),
  });
  const http: HttpClient = execution.captureResponses
    ? {
        async request(request) {
          const response = await runtime.http.request(request);
          if (new TextEncoder().encode(response.text).byteLength > 1_048_576)
            throw new ConnectorError("schema_changed");
          execution.responses.push({ request, response });
          return response;
        },
      }
    : runtime.http;
  const connector = platform.createConnector({
    tenant,
    courts: [options.court],
    http,
    now: io.now ?? (() => new Date()),
  });
  const reading = await runtime.execute(() =>
    connector.readCourt(options.court, { start: options.date, end }),
  );
  if (
    reading.attribution.parkUrl !== undefined &&
    park.courttideSlug === undefined
  )
    throw new ConnectorError("schema_changed");
  return { reading, requestLog, gateLog, responses: execution.responses };
}

function localClock(instant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instant));
}

export function formatReading(
  reading: ReadResult["reading"],
  timeZone: string,
): string {
  const lines = reading.days.map((day) => {
    const open =
      day.intervals
        .filter((interval) => interval.available)
        .map(
          (interval) =>
            `${localClock(interval.start, timeZone)}–${localClock(interval.end, timeZone)}`,
        )
        .join(", ") || "none";
    return `${day.date} status=${day.status} visibility=${day.visibility} coverage=${day.coverage} usable=${day.usable} open=${open}`;
  });
  lines.push(`${ATTRIBUTION.text} · ${ATTRIBUTION.url}`);
  return lines.join("\n");
}
