import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { runConformance } from "../testing/conformance.js";
import type { Platform } from "../contract/types.js";
import { loadConfig } from "./config.js";
import { getPlatform } from "./registry.js";
import { conformanceFixturePath } from "./registry.js";

interface FixtureResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Fixture data is missing or invalid");
  }
}

function fixtureDirectories(path: string): string[] {
  const absolute = resolve(path);
  if (!statSync(absolute).isDirectory())
    throw new Error("Fixture path must be a directory");
  if (existsSync(join(absolute, "meta.json"))) return [absolute];
  return readdirSync(absolute, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(absolute, entry.name))
    .filter((directory) => existsSync(join(directory, "meta.json")))
    .sort();
}

function requestPath(value: unknown): string {
  if (
    !value ||
    typeof value !== "object" ||
    !("url" in value) ||
    typeof value.url !== "string"
  )
    throw new Error("Fixture request is invalid");
  const url = new URL(value.url);
  return `${url.pathname}${url.search}`;
}

function responseHeaders(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  const allowed = new Set([
    "content-type",
    "set-cookie",
    "retry-after",
    "location",
    "refresh",
  ]);
  const result: Record<string, string> = {};
  const pairs = Array.isArray(value)
    ? value.filter(
        (entry): entry is [string, string] =>
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "string",
      )
    : Object.entries(value);
  for (const [key, item] of pairs) {
    if (allowed.has(key.toLowerCase()) && typeof item === "string")
      result[key.toLowerCase()] = item;
  }
  return result;
}

function routesFrom(path: string): Map<string, FixtureResponse[]> {
  const routes = new Map<string, FixtureResponse[]>();
  const routeOwners = new Map<string, string>();
  for (const directory of fixtureDirectories(path)) {
    const meta = readJson(join(directory, "meta.json")) as { source?: unknown };
    if (meta.source !== "synthetic" && meta.source !== "recorded")
      throw new Error("Fixture source must be synthetic or recorded");
    const requests = readJson(join(directory, "requests.json"));
    const responses = readJson(join(directory, "responses.json"));
    if (
      !Array.isArray(requests) ||
      !Array.isArray(responses) ||
      requests.length < 1 ||
      requests.length !== responses.length
    )
      throw new Error("Fixture request and response counts must match");
    for (const [index, request] of requests.entries()) {
      const route = requestPath(request);
      const owner = routeOwners.get(route);
      if (owner && owner !== directory)
        throw new Error("Fixture route is ambiguous; serve one case directory");
      routeOwners.set(route, directory);
      const response = responses[index] as FixtureResponse;
      if (typeof response.status !== "number")
        throw new Error("Fixture response status is missing");
      const queue = routes.get(route) ?? [];
      queue.push({
        status: response.status,
        headers: responseHeaders(response.headers),
        body: typeof response.body === "string" ? response.body : null,
      });
      routes.set(route, queue);
    }
  }
  if (!routes.size) throw new Error("No one-request fixtures found");
  return routes;
}

export interface FixtureServer {
  url: string;
  close(): Promise<void>;
  server: Server;
}

function inapplicableCases(platform: Platform): Record<string, string> {
  if (platform.id === "activenet")
    return {
      challenge:
        "The ActiveNet transport profile has no challenge detector; HTML is rejected by its JSON-only content-type rule.",
      passive_challenge_asset:
        "The ActiveNet transport profile has no passive challenge assets.",
      missing_token: "ActiveNet does not bootstrap or use a session token.",
      bad_cookie: "ActiveNet does not bootstrap or use a cookie jar.",
      expired_session: "ActiveNet has no session bootstrap or expiry state.",
      cached_bootstrap_failure:
        "ActiveNet does not bootstrap or cache a session.",
    };
  if (platform.id === "civicrec")
    return {
      explicit_taken_interval:
        "The endpoint reports positive ranges only and does not assert taken intervals.",
      whole_day_closed: "The endpoint has no whole-day closed status.",
      whole_day_booked: "The endpoint has no whole-day booked status.",
      unknown_status:
        "The endpoint has no status enumeration; malformed eligibility signals are covered by parser tests.",
      wrong_id:
        "The hours response does not echo a facility identifier and identity mode is none.",
      missing_date:
        "Each requested date has its own response rather than a list of date rows.",
      duplicate_date:
        "Each requested date has its own response rather than a list of date rows.",
      instruction_like_label:
        "The hours response has no court label and configured labels are not read or returned.",
    };
  return {};
}

export async function startFixtureServer(
  path: string,
  port = 0,
): Promise<FixtureServer> {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error("Port must be from 0 through 65535");
  const routes = routesFrom(path);
  const server = createServer((request, response) => {
    const route = request.url ?? "/";
    if (request.method !== "GET") {
      response
        .writeHead(405, { "content-type": "text/plain" })
        .end("method_not_allowed");
      return;
    }
    const fixture = routes.get(route)?.shift();
    if (!fixture) {
      response
        .writeHead(404, { "content-type": "text/plain" })
        .end("fixture_not_found");
      return;
    }
    response.writeHead(fixture.status ?? 200, fixture.headers);
    response.end(fixture.body ?? undefined);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const address = server.address() as AddressInfo;
  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    server,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    },
  };
}

export async function replayFixtures(
  path: string,
): Promise<{ platform: Platform; fixtures: number; cases: string[] }> {
  const directories = fixtureDirectories(path);
  const casesRoot = resolve(path);
  let replayRoot = casesRoot;
  let temporary: string | undefined;
  if (directories.length === 1 && directories[0] === casesRoot) {
    temporary = mkdtempSync(join(tmpdir(), "courttide-replay-"));
    const single = readJson(join(casesRoot, "meta.json")) as {
      configPath?: unknown;
    };
    if (typeof single.configPath !== "string") {
      rmSync(temporary, { recursive: true, force: true });
      throw new Error("Fixture config reference is missing");
    }
    const tenant = loadConfig(resolve(casesRoot, single.configPath), "/");
    const sourceRoot = resolve(
      process.cwd(),
      conformanceFixturePath(tenant.platform),
    );
    cpSync(sourceRoot, temporary, { recursive: true });
    for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const sourceDirectory = join(sourceRoot, entry.name);
      const metaPath = join(sourceDirectory, "meta.json");
      if (!existsSync(metaPath)) continue;
      const meta = readJson(metaPath) as { configPath?: unknown };
      if (typeof meta.configPath !== "string") continue;
      const copiedMeta = {
        ...meta,
        configPath: resolve(sourceDirectory, meta.configPath),
      };
      writeFileSync(
        join(temporary, entry.name, "meta.json"),
        `${JSON.stringify(copiedMeta, null, 2)}\n`,
      );
    }
    const copy = join(temporary, "local-recording");
    cpSync(casesRoot, copy, { recursive: true });
    replayRoot = temporary;
  }
  try {
    const firstMeta = readJson(join(directories[0]!, "meta.json")) as {
      configPath?: unknown;
    };
    if (typeof firstMeta.configPath !== "string")
      throw new Error("Fixture config reference is missing");
    const tenant = loadConfig(
      resolve(directories[0]!, firstMeta.configPath),
      "/",
    );
    const platform = getPlatform(tenant.platform);
    const result = await runConformance(platform, replayRoot, {
      inapplicableCases: inapplicableCases(platform),
    });
    return { platform, ...result };
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
