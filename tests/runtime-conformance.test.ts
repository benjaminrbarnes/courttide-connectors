import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ATTRIBUTION,
  civicRecLegacyProfile,
  parseAnonymousBootstrap,
} from "../packages/connectors/src/index.js";
import type {
  CourtReading,
  Platform,
  TenantConfig,
} from "../packages/connectors/src/index.js";
import {
  CONFORMANCE_CASES,
  runConformance,
} from "../packages/connectors/src/testing/index.js";
import {
  bootstrapRequest,
  civicRequest,
  civicTenant,
  now,
} from "./runtime-support.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const parser = { id: "example", version: "1", signature: "example" };
const capabilities = {
  auth: "none",
  shape: "continuous_ranges",
  maxDaysPerRead: 2,
  leaseScope: "per_request",
  requests: { perRead: 1, perSessionBootstrap: 1 },
  minimumGapMs: 10000,
  identity: "none",
  bookingWrites: false,
} as const;
function reading(tenant: TenantConfig): CourtReading {
  return {
    platform: "civicrec",
    tenant: tenant.tenant,
    court: "900003",
    startDate: "2026-11-04",
    endDate: "2026-11-04",
    complete: true,
    observedAt: now().toISOString(),
    sourceUrl: bootstrapRequest().url.href,
    days: [
      {
        date: "2026-11-04",
        status: 200,
        visibility: "visible",
        coverage: "partial",
        usable: true,
        reasonCodes: ["reported_ranges_only"],
        intervals: [
          {
            start: "2026-11-04T10:00:00.000Z",
            end: "2026-11-04T11:00:00.000Z",
            available: true,
          },
        ],
        evidence: {
          kind: "continuous_ranges",
          scope: "reported_ranges_only",
          startIncrementMinutes: 15,
          startAnchor: "range_start",
          minimumOccupiedMinutes: 60,
          durationStepMinutes: 15,
        },
      },
    ],
    sanitized: {},
    parser,
    attribution: {
      ...ATTRIBUTION,
      parkUrl: "https://courttide.com/courts/example-park",
    },
  };
}
const platform: Platform = {
  id: "civicrec",
  parser,
  tenantParams: z.unknown(),
  courtParams: z.unknown(),
  transport: civicRecLegacyProfile,
  capabilities: () => capabilities,
  createConnector(context) {
    return {
      capabilities,
      async readCourt() {
        const bootstrap = bootstrapRequest();
        const response = await context.http.request(bootstrap);
        const state = parseAnonymousBootstrap({
          html: response.text,
          headers: response.headers,
          catalogUrl: bootstrap.url,
          receivedAt: response.receivedAt,
          cookieDomains: ["secure.rec1.com", "rec1.com"],
        });
        const calendar = civicRequest();
        calendar.headers!.cookie = state.cookie;
        const observed = await context.http.request(calendar);
        return { ...reading(context.tenant), observedAt: observed.receivedAt };
      },
    };
  },
};

it("runs a synthetic bootstrap and cookie-bound read through the default conformance runtime", async () => {
  const globalFetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => {
    throw new Error("Unexpected network");
  });
  const root = mkdtempSync(join(tmpdir(), "connector-fixture-"));
  roots.push(root);
  const directory = join(root, "open");
  mkdirSync(directory);
  const bootstrap = bootstrapRequest();
  const calendar = civicRequest();
  calendar.headers!.cookie = "ExampleSession=example-token";
  const page =
    "{&quot;checkoutData&quot;:{&quot;user&quot;:null,&quot;key&quot;:&quot;example-session&quot;}}";
  const html = `<div data-page-data='${page}' data-base-path='/XX/example-city/'></div>`;
  const meta = {
    source: "synthetic",
    cases: ["open_interval"],
    clockNow: now().toISOString(),
    configPath: resolve("examples/tenants/civicrec.json"),
    court: "900003",
    range: { start: "2026-11-04", end: "2026-11-04" },
    secrets: ["example-session", "example-token"],
  };
  const fetchInit = (headers: Record<string, string>) => ({
    method: "GET",
    headers,
    credentials: "omit",
    redirect: "manual",
    cache: "no-store",
    signal: "present",
  });
  const gateRequest = (request: typeof bootstrap) => ({
    court: request.court,
    purpose: request.purpose,
    method: request.method,
    url: request.url.href,
  });
  const files = {
    "meta.json": meta,
    "responses.json": [
      {
        status: 200,
        headers: [
          ["content-type", "text/html"],
          ["set-cookie", "ExampleSession=example-token; Path=/; Secure"],
        ],
        body: html,
      },
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: "{}",
      },
    ],
    "requests.json": [
      { url: bootstrap.url.href, init: fetchInit(bootstrap.headers!) },
      { url: calendar.url.href, init: fetchInit(calendar.headers!) },
    ],
    "gate.json": [
      { type: "acquire", request: gateRequest(bootstrap) },
      { type: "release", ticket: 1, outcome: { ok: true, status: 200 } },
      { type: "acquire", request: gateRequest(calendar) },
      { type: "release", ticket: 2, outcome: { ok: true, status: 200 } },
    ],
    "expected.json": reading(civicTenant),
  };
  for (const [name, value] of Object.entries(files))
    writeFileSync(join(directory, name), JSON.stringify(value));
  const inapplicableCases = Object.fromEntries(
    CONFORMANCE_CASES.filter((name) => name !== "open_interval").map((name) => [
      name,
      "The toy platform exercises one synthetic read.",
    ]),
  );
  await expect(
    runConformance(platform, root, { inapplicableCases }),
  ).resolves.toEqual({ fixtures: 1, cases: ["open_interval"] });
  await expect(
    runConformance(platform, root, { inapplicableCases }),
  ).resolves.toEqual({ fixtures: 1, cases: ["open_interval"] });
  expect(globalFetch).not.toHaveBeenCalled();
});
