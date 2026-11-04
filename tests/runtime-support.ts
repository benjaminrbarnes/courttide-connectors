import { readFileSync } from "node:fs";
import type {
  Gate,
  HttpRequest,
  TenantConfig,
  TransportProfile,
} from "../packages/connectors/src/index.js";
import { createConnectorRuntime } from "../packages/connectors/src/index.js";

export const activeTenant = JSON.parse(
  readFileSync("examples/tenants/activenet.json", "utf8"),
) as TenantConfig;
export const civicTenant = JSON.parse(
  readFileSync("examples/tenants/civicrec.json", "utf8"),
) as TenantConfig;
export const now = () => new Date("2026-11-04T12:00:00.000Z");

export function activeRequest(): HttpRequest {
  const path =
    "/exampleparks/rest/reservation/resource/availability/daily/900001";
  const query =
    "?start_date=2026-11-04&end_date=2026-11-04&customer_id=0&company_id=0&locale=en-US";
  return {
    court: "900001",
    purpose: "calendar",
    method: "GET",
    url: new URL(`${activeTenant.origin}${path}${query}`),
    headers: { accept: "application/json" },
    expect: "json",
  };
}
export function civicRequest(): HttpRequest {
  const path =
    "/XX/example-city/catalog/getFacilityHours/example-session/900003/900004/2026-11-04";
  return {
    court: "900003",
    purpose: "calendar",
    method: "GET",
    url: new URL(`${civicTenant.origin}${path}`),
    headers: {
      accept: "application/json",
      "x-requested-with": "XMLHttpRequest",
    },
    expect: "json",
  };
}
export function bootstrapRequest(): HttpRequest {
  return {
    court: "900003",
    purpose: "bootstrap",
    method: "GET",
    url: new URL(`${civicTenant.origin}/XX/example-city/catalog`),
    headers: { accept: "text/html" },
    expect: "html",
  };
}
export function runtime(
  tenant: TenantConfig,
  profile: TransportProfile,
  gate: Gate,
  fetch: typeof globalThis.fetch,
  options: {
    leaseScope?: "per_read" | "per_request";
    signal?: AbortSignal;
    monotonicNow?: () => number;
  } = {},
) {
  return createConnectorRuntime({
    tenant,
    profile,
    gate,
    fetch,
    now,
    leaseScope: options.leaseScope ?? "per_request",
    signal: options.signal,
    monotonicNow: options.monotonicNow,
  });
}
