import { readFileSync } from "node:fs";
import { vi } from "vitest";
import {
  createConnectorRuntime,
  type Gate,
  type SessionStore,
  type TenantConfig,
  type TransportProfile,
} from "../../packages/connectors/src/index.js";
import { civicRecPlatform } from "../../packages/connectors/src/platforms/civicrec/index.js";
import { createRecordingGate } from "../../packages/connectors/src/testing/index.js";

export const tenant = JSON.parse(
  readFileSync("examples/tenants/civicrec.json", "utf8"),
) as TenantConfig;
const start = "2026-11-04";
const end = "2026-11-05";
export const range = { start, end };
export const clock = () => new Date();

export function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
export function response(
  cookie = "ExampleSession=example-token; Path=/; Secure",
) {
  const headers = new Headers({ "content-type": "text/html" });
  headers.append("set-cookie", cookie);
  return new Response(
    `<div data-page-data='{"checkoutData":{"user":null,"key":"example-session"}}' data-base-path='/XX/example-city/'></div>`,
    { status: 200, headers },
  );
}
export function transport(
  options: {
    bootstrap?: (count: number) => Promise<Response> | Response;
    calendar?: (count: number) => Response;
  } = {},
) {
  const requests: { bootstrap: boolean; cookie: string | null }[] = [];
  let bootstraps = 0;
  let calendars = 0;
  const fetcher: typeof fetch = async (input, init) => {
    const bootstrap = new URL(String(input)).pathname.endsWith("/catalog");
    requests.push({
      bootstrap,
      cookie: new Headers(init?.headers).get("cookie"),
    });
    if (bootstrap) return options.bootstrap?.(++bootstraps) ?? response();
    return (
      options.calendar?.(++calendars) ??
      new Response(
        JSON.stringify({ hours: [], displayHours: [], availableForRate: true }),
        { headers: { "content-type": "application/json" } },
      )
    );
  };
  return { fetcher, requests };
}
export function job(options: {
  store: SessionStore;
  fetcher: typeof fetch;
  config?: TenantConfig;
  court?: string;
  signal?: AbortSignal;
  profile?: TransportProfile;
  identity?: object;
  gate?: Gate;
}) {
  const config = options.config ?? tenant;
  const court = options.court ?? "900003";
  const recording = createRecordingGate();
  const runtime = createConnectorRuntime({
    tenant: config,
    profile: options.profile ?? civicRecPlatform.transport,
    leaseScope: "per_request",
    fetch: options.fetcher,
    gate: options.gate ?? recording.gate,
    now: clock,
    monotonicNow: () => 0,
    signal: options.signal,
    sessionStore: options.store,
    sessionAccount: "anonymous",
    sessionTransportIdentity: options.identity,
  });
  const connector = civicRecPlatform.createConnector({
    tenant: config,
    courts: [court],
    http: runtime.http,
    now: clock,
    signal: options.signal,
  });
  return {
    runtime,
    recording,
    read: () => runtime.execute(() => connector.readCourt(court, range)),
  };
}

export function freezeClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-04T12:00:00.000Z"));
}
