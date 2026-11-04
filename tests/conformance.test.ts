import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ATTRIBUTION,
  ConnectorError,
} from "../packages/connectors/src/index.js";
import type {
  HttpClient,
  Platform,
  TransportProfile,
} from "../packages/connectors/src/index.js";
import {
  assertCaseMatrix,
  CONFORMANCE_CASES,
  createFakeFetch,
  createRecordingGate,
  frozenClock,
  runConformance,
} from "../packages/connectors/src/testing/index.js";
import type { HarnessArguments } from "../packages/connectors/src/testing/index.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const capabilities = {
  auth: "none",
  shape: "full_calendar",
  maxDaysPerRead: 1,
  leaseScope: "per_request",
  requests: { perRead: 1, perSessionBootstrap: 0 },
  minimumGapMs: 10000,
  identity: "none",
  bookingWrites: false,
} as const;
const transport: TransportProfile = {
  retryAfter: "strict-imf",
  successStatuses: "any-2xx",
  redirectHeaders: [],
  readBodyOnlyOnSuccess: true,
  contentLengthChecks: false,
  jsonContentTypes: ["application/json"],
  htmlContentTypes: [],
  challenge: null,
  headers: { accept: { required: true } },
  urlGrammar: { GET: () => true },
  cookieJar: null,
};
const toy: Platform = {
  id: "example",
  parser: { id: "example", version: "1", signature: "example" },
  tenantParams: z.unknown(),
  courtParams: z.unknown(),
  transport,
  capabilities: () => capabilities,
  createConnector: ({ http }) => ({
    capabilities,
    async readCourt(court) {
      const response = await http.request({
        court,
        purpose: "calendar",
        method: "GET",
        url: new URL("https://example.invalid/"),
        headers: { accept: "application/json" },
        expect: "json",
      });
      return JSON.parse(response.text);
    },
  }),
};

function harness({ fetch, gate, now }: HarnessArguments) {
  const http: HttpClient = {
    async request(request) {
      const ticket = await gate.acquire({
        court: request.court,
        purpose: request.purpose,
        method: request.method,
        url: request.url.toString(),
      });
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
      });
      const text = await response.text();
      await gate.release(ticket, { ok: true, status: response.status });
      return {
        status: response.status,
        headers: response.headers,
        text,
        requestedAt: now().toISOString(),
        receivedAt: now().toISOString(),
      };
    },
  };
  return { http, execute: <T>(operation: () => Promise<T>) => operation() };
}

const notApplicable = Object.fromEntries(
  CONFORMANCE_CASES.filter((name) => name !== "open_interval").map((name) => [
    name,
    "The toy platform implements only one synthetic case.",
  ]),
);
function writeFixture(root: string) {
  const directory = join(root, "open");
  mkdirSync(directory);
  const config = JSON.parse(
    readFileSync("examples/tenants/example.json", "utf8"),
  );
  const meta = {
    source: "synthetic",
    cases: ["open_interval"],
    clockNow: "2026-11-04T09:00:00.000Z",
    configPath: resolve("examples/tenants/example.json"),
    court: "900001",
    range: { start: "2026-11-04", end: "2026-11-04" },
  };
  const output = {
    platform: "example",
    tenant: config.tenant,
    court: "900001",
    startDate: meta.range.start,
    endDate: meta.range.end,
    complete: true,
    observedAt: meta.clockNow,
    sourceUrl: "https://example.invalid/",
    days: [
      {
        date: meta.range.start,
        status: 200,
        visibility: "visible",
        coverage: "complete",
        usable: true,
        reasonCodes: [],
        intervals: [
          {
            start: "2026-11-04T10:00:00.000Z",
            end: "2026-11-04T11:00:00.000Z",
            available: true,
          },
        ],
      },
    ],
    sanitized: {},
    parser: toy.parser,
    attribution: {
      ...ATTRIBUTION,
      parkUrl: "https://courttide.com/courts/example-park",
    },
  };
  const request = {
    court: "900001",
    purpose: "calendar",
    method: "GET",
    url: "https://example.invalid/",
  };
  const files = {
    "meta.json": meta,
    "responses.json": [
      {
        status: 200,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(output),
      },
    ],
    "expected.json": output,
    "requests.json": [
      {
        url: request.url,
        init: {
          method: "GET",
          headers: { accept: "application/json" },
          credentials: "omit",
          redirect: "manual",
          cache: "no-store",
        },
      },
    ],
    "gate.json": [
      { type: "acquire", request },
      { type: "release", ticket: 1, outcome: { ok: true, status: 200 } },
    ],
  };
  for (const [name, value] of Object.entries(files))
    writeFileSync(join(directory, name), JSON.stringify(value));
  return directory;
}

describe("conformance kit", () => {
  it("replays a toy platform with an injected harness and catches mismatches", async () => {
    const root = mkdtempSync(join(tmpdir(), "connector-fixture-"));
    roots.push(root);
    const directory = writeFixture(root);
    await expect(
      runConformance(toy, root, {
        createHarness: harness,
        inapplicableCases: notApplicable,
      }),
    ).resolves.toEqual({ fixtures: 1, cases: ["open_interval"] });
    writeFileSync(join(directory, "requests.json"), "[]");
    await expect(
      runConformance(toy, root, {
        createHarness: harness,
        inapplicableCases: notApplicable,
      }),
    ).rejects.toThrow("requests");
  });

  it("checks deferred acquisition through the fixture runner without a release", async () => {
    const root = mkdtempSync(join(tmpdir(), "connector-fixture-"));
    roots.push(root);
    const directory = writeFixture(root);
    const meta = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8"));
    meta.gateDeferral = {
      acquire: 1,
      until: "2026-11-04T10:00:00.000Z",
      reason: "pacing",
    };
    writeFileSync(join(directory, "meta.json"), JSON.stringify(meta));
    writeFileSync(join(directory, "responses.json"), "[]");
    writeFileSync(join(directory, "requests.json"), "[]");
    const gate = JSON.parse(readFileSync(join(directory, "gate.json"), "utf8"));
    writeFileSync(join(directory, "gate.json"), JSON.stringify([gate[0]]));
    unlinkSync(join(directory, "expected.json"));
    writeFileSync(
      join(directory, "error.json"),
      JSON.stringify({
        name: "GateDeferred",
        until: meta.gateDeferral.until,
        reason: "pacing",
      }),
    );
    await expect(
      runConformance(toy, root, {
        createHarness: harness,
        inapplicableCases: notApplicable,
      }),
    ).resolves.toBeDefined();
  });

  it("checks a parser-time block reaches a per-read release", async () => {
    const root = mkdtempSync(join(tmpdir(), "connector-fixture-"));
    roots.push(root);
    const directory = writeFixture(root);
    const perRead = { ...capabilities, leaseScope: "per_read" as const };
    const blocked: Platform = {
      ...toy,
      capabilities: () => perRead,
      createConnector: ({ http }) => ({
        capabilities: perRead,
        async readCourt(court) {
          await http.request({
            court,
            purpose: "calendar",
            method: "GET",
            url: new URL("https://example.invalid/"),
            headers: { accept: "application/json" },
            expect: "json",
          });
          throw new ConnectorError("access_blocked");
        },
      }),
    };
    const perReadHarness = ({ fetch, gate, now }: HarnessArguments) => {
      let ticket: unknown;
      const http: HttpClient = {
        async request(request) {
          ticket = await gate.acquire({
            court: request.court,
            purpose: request.purpose,
            method: request.method,
            url: request.url.toString(),
          });
          const response = await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            credentials: "omit",
            redirect: "manual",
            cache: "no-store",
          });
          return {
            status: response.status,
            headers: response.headers,
            text: await response.text(),
            requestedAt: now().toISOString(),
            receivedAt: now().toISOString(),
          };
        },
      };
      return {
        http,
        async execute<T>(operation: () => Promise<T>) {
          try {
            return await operation();
          } catch (error) {
            await gate.release(ticket, { ok: false, error: "access_blocked" });
            throw error;
          }
        },
      };
    };
    const calls = JSON.parse(
      readFileSync(join(directory, "gate.json"), "utf8"),
    );
    calls[1].outcome = { ok: false, error: "access_blocked" };
    writeFileSync(join(directory, "gate.json"), JSON.stringify(calls));
    unlinkSync(join(directory, "expected.json"));
    writeFileSync(
      join(directory, "error.json"),
      JSON.stringify({
        name: "ConnectorError",
        code: "access_blocked",
        retryable: false,
        retryAfterMs: null,
      }),
    );
    await expect(
      runConformance(blocked, root, {
        createHarness: perReadHarness,
        inapplicableCases: notApplicable,
      }),
    ).resolves.toBeDefined();
  });

  it("requires a reflected-secret fixture to fail the read", async () => {
    const root = mkdtempSync(join(tmpdir(), "connector-fixture-"));
    roots.push(root);
    const directory = writeFixture(root);
    const meta = JSON.parse(readFileSync(join(directory, "meta.json"), "utf8"));
    meta.secrets = ["example-token"];
    meta.rejectSecretEcho = true;
    writeFileSync(join(directory, "meta.json"), JSON.stringify(meta));
    const output = JSON.parse(
      readFileSync(join(directory, "expected.json"), "utf8"),
    );
    output.sanitized = { value: "example-token" };
    writeFileSync(join(directory, "expected.json"), JSON.stringify(output));
    writeFileSync(
      join(directory, "responses.json"),
      JSON.stringify([{ status: 200, body: JSON.stringify(output) }]),
    );
    await expect(
      runConformance(toy, root, {
        createHarness: harness,
        inapplicableCases: notApplicable,
      }),
    ).rejects.toThrow("Reflected secrets must fail the read");
  });

  it("records deferrals without releases, and rejects duplicate releases", async () => {
    const record = createRecordingGate({
      acquire: 1,
      until: "2026-11-04T10:00:00.000Z",
      reason: "pacing",
    });
    const request = {
      court: "900001",
      purpose: "calendar",
      method: "GET",
      url: "https://example.invalid/",
    } as const;
    await expect(record.gate.acquire(request)).rejects.toMatchObject({
      name: "GateDeferred",
      reason: "pacing",
    });
    expect(record.calls).toEqual([{ type: "acquire", request }]);
    const ticket = await record.gate.acquire(request);
    await expect(record.gate.release(ticket, { ok: false })).rejects.toThrow(
      "Invalid gate outcome",
    );
    await record.gate.release(ticket, { ok: true });
    await expect(record.gate.release(ticket, { ok: true })).rejects.toThrow();
  });

  it("keeps fetch and clock deterministic and simulates body and transport failures", async () => {
    const fake = createFakeFetch([
      { status: 200, body: "example" },
      { failure: "timeout" },
      { bodyFailure: "network" },
    ]);
    const now = frozenClock("2026-11-04T09:00:00.000Z");
    now().setTime(0);
    expect(now().toISOString()).toBe("2026-11-04T09:00:00.000Z");
    expect(await (await fake.fetch("https://example.invalid/")).text()).toBe(
      "example",
    );
    await expect(fake.fetch("https://example.invalid/")).rejects.toMatchObject({
      name: "TimeoutError",
    });
    await expect(
      (await fake.fetch("https://example.invalid/")).text(),
    ).rejects.toThrow();
    expect(fake.remaining()).toBe(0);
  });

  it("requires every case or an explicit reason", () => {
    expect(() =>
      assertCaseMatrix(["open_interval"], notApplicable),
    ).not.toThrow();
    expect(() => assertCaseMatrix(["open_interval"])).toThrow(
      "Missing conformance case",
    );
    expect(() => assertCaseMatrix(["unknown_case"], notApplicable)).toThrow(
      "Unknown conformance case",
    );
  });
});
