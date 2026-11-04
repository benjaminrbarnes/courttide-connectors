import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import {
  createConnectorRuntime,
  readingSchema,
} from "../packages/connectors/src/index.js";
import type {
  HttpClient,
  TenantConfig,
} from "../packages/connectors/src/index.js";
import {
  createFakeFetch,
  createRecordingGate,
} from "../packages/connectors/src/testing/index.js";
import type { FakeResponse } from "../packages/connectors/src/testing/index.js";
import { civicRecPlatform } from "../packages/connectors/src/platforms/civicrec/index.js";

const tenant = JSON.parse(
  readFileSync("examples/tenants/civicrec.json", "utf8"),
) as TenantConfig;
const date = "2026-11-04";
const clock = () => new Date("2026-11-04T12:00:00.000Z");
const html = `<div data-page-data='{"checkoutData":{"user":null,"key":"example-session"}}' data-base-path='/XX/example-city/'></div>`;
const bootstrap: FakeResponse = {
  status: 200,
  headers: [
    ["content-type", "text/html"],
    ["set-cookie", "ExampleSession=example-token; Path=/; Secure"],
  ],
  body: html,
};
function range(
  day: string,
  start: string,
  end: string,
  extra: Record<string, unknown> = {},
) {
  return {
    start: Date.parse(`${day}T${start}:00Z`) / 1000,
    end: Date.parse(`${day}T${end}:00Z`) / 1000,
    startDtm: `${day} ${start}:00`,
    endDtm: `${day} ${end}:00`,
    fragment: false,
    block: false,
    rateType: { id: "900004" },
    ...extra,
  };
}
function payload(day = date, ranges = [range(day, "08:00", "10:00")]) {
  return {
    hours: ranges,
    displayHours: structuredClone(ranges),
    availableForRate: true,
  };
}
function json(body: unknown): FakeResponse {
  return {
    status: 200,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}
function harness(responses: FakeResponse[], config = tenant) {
  const fake = createFakeFetch(responses);
  const recording = createRecordingGate();
  const runtime = createConnectorRuntime({
    tenant: config,
    profile: civicRecPlatform.transport,
    leaseScope: "per_request",
    fetch: fake.fetch,
    gate: recording.gate,
    now: clock,
    monotonicNow: () => 0,
  });
  const connector = civicRecPlatform.createConnector({
    tenant: config,
    http: runtime.http,
    now: clock,
  });
  return { fake, recording, runtime, connector };
}

const one = { start: date, end: date };
describe("CivicRec platform", () => {
  it("reuses bootstrap over a range, keeps explicit overlaps and clamps each open interval", async () => {
    const rows = [
      range(date, "08:00", "10:00"),
      range(date, "09:00", "11:00"),
      range(date, "08:00", "10:00"),
      range(date, "12:00", "13:00", { block: true }),
      range(date, "21:30", "23:00"),
    ];
    const next = "2026-11-05";
    const h = harness([
      bootstrap,
      json(payload(date, rows)),
      json(payload(next)),
    ]);
    const reading = await h.runtime.execute(() =>
      h.connector.readCourt("900003", { start: date, end: next }),
    );
    expect(reading.complete).toBe(true);
    expect(reading.days[0]).toMatchObject({
      coverage: "partial",
      visibility: "visible",
      usable: true,
      reasonCodes: ["reported_ranges_only"],
      evidence: {
        kind: "continuous_ranges",
        scope: "reported_ranges_only",
        startAnchor: "range_start",
      },
    });
    expect(reading.days[0]!.intervals).toEqual([
      {
        start: "2026-11-04T08:00:00Z",
        end: "2026-11-04T10:00:00Z",
        available: true,
      },
      {
        start: "2026-11-04T09:00:00Z",
        end: "2026-11-04T11:00:00Z",
        available: true,
      },
      {
        start: "2026-11-04T08:00:00Z",
        end: "2026-11-04T10:00:00Z",
        available: true,
      },
      {
        start: "2026-11-04T21:30:00Z",
        end: "2026-11-04T22:00:00Z",
        available: true,
      },
    ]);
    expect(reading.days[1]).toMatchObject({
      date: next,
      coverage: "partial",
      usable: true,
    });
    expect(
      readingSchema({
        shape: "continuous_ranges",
        timeZone: "UTC",
        parkSlug: "example-park",
        secrets: ["example-session", "example-token"],
      }).safeParse(reading).success,
    ).toBe(true);
    expect(JSON.stringify(reading)).not.toMatch(
      /example-session|example-token|getFacilityHours|startDtm/,
    );
    expect(
      h.fake.requests.map(
        (request) => new URL(request.url).pathname.split("/")[4] ?? "bootstrap",
      ),
    ).toEqual(["bootstrap", "getFacilityHours", "getFacilityHours"]);
    expect(h.recording.calls).toHaveLength(6);
  });

  it("handles hidden, empty, conflicting and partial responses with ordered reasons", async () => {
    const hidden = payload();
    hidden.availableForRate = false;
    const empty = { hours: [], displayHours: [], availableForRate: true };
    const conflicting = payload();
    conflicting.displayHours = [range(date, "09:00", "10:00")];
    const badSignal = { ...payload(), info: "\u0001" };
    const hiddenWithIssue = {
      ...payload(),
      availableForRate: false,
      info: "\u0001",
    };
    for (const [body, expected] of [
      [
        hidden,
        {
          complete: true,
          visibility: "hidden_or_unavailable",
          reasons: [
            "reported_ranges_only",
            "source_hidden_or_unavailable",
            "occupancy_unknown",
          ],
        },
      ],
      [
        empty,
        {
          complete: true,
          visibility: "unknown",
          reasons: [
            "reported_ranges_only",
            "empty_hours",
            "empty_display_hours",
            "occupancy_unknown",
          ],
        },
      ],
      [
        conflicting,
        {
          complete: false,
          visibility: "unknown",
          reasons: [
            "reported_ranges_only",
            "display_hours_conflict",
            "occupancy_unknown",
          ],
        },
      ],
      [
        badSignal,
        {
          complete: false,
          visibility: "unknown",
          reasons: [
            "reported_ranges_only",
            "invalid_signal",
            "occupancy_unknown",
          ],
        },
      ],
      [
        hiddenWithIssue,
        {
          complete: false,
          visibility: "hidden_or_unavailable",
          reasons: [
            "reported_ranges_only",
            "invalid_signal",
            "source_hidden_or_unavailable",
            "occupancy_unknown",
          ],
        },
      ],
    ] as const) {
      const h = harness([bootstrap, json(body)]);
      const reading = await h.connector.readCourt("900003", one);
      expect(reading.complete).toBe(expected.complete);
      expect(reading.days[0]).toMatchObject({
        visibility: expected.visibility,
        usable: false,
        intervals: [],
        reasonCodes: expected.reasons,
        evidence: { scope: "reported_ranges_only" },
      });
    }
  });

  it("retains one usable day while another day makes the range incomplete", async () => {
    const next = "2026-11-05";
    const conflict = payload(next);
    conflict.displayHours = [range(next, "09:00", "10:00")];
    const h = harness([bootstrap, json(payload()), json(conflict)]);
    const reading = await h.connector.readCourt("900003", {
      start: date,
      end: next,
    });
    expect(reading.complete).toBe(false);
    expect(reading.days[0]).toMatchObject({
      coverage: "partial",
      visibility: "visible",
      usable: true,
    });
    expect(reading.days[1]).toMatchObject({
      coverage: "partial",
      visibility: "unknown",
      usable: false,
      intervals: [],
      reasonCodes: [
        "reported_ranges_only",
        "display_hours_conflict",
        "occupancy_unknown",
      ],
    });
  });

  it("reuses the same session across explicitly selected courts", async () => {
    const config = structuredClone(tenant);
    const second = structuredClone(config.parks[0]!.courts[0]!);
    second.key = "900006";
    (second.params as Record<string, unknown>).facilityId = 900006;
    config.parks[0]!.courts.push(second);
    const h = harness([bootstrap, json(payload()), json(payload())], config);
    expect(h.connector.capabilities.identity).toBe("none");
    expect(h.connector.verifyCourt).toBeUndefined();
    expect((await h.connector.readCourt("900003", one)).court).toBe("900003");
    expect((await h.connector.readCourt("900006", one)).court).toBe("900006");
    expect(
      h.fake.requests.filter((request) => request.url.endsWith("/catalog")),
    ).toHaveLength(1);
    expect(h.fake.requests.at(-1)!.url).toContain("/900006/900004/");
  });

  it("coalesces a concurrent bootstrap and caches both success and failure", async () => {
    const h = harness([bootstrap, json(payload()), json(payload())]);
    await Promise.all([
      h.connector.readCourt("900003", one),
      h.connector.readCourt("900003", one),
    ]);
    expect(
      h.fake.requests.filter((request) => request.url.endsWith("/catalog")),
    ).toHaveLength(1);
    expect(h.fake.requests).toHaveLength(3);
    const failed = harness([{ ...bootstrap, body: "<html></html>" }]);
    for (let i = 0; i < 2; i += 1)
      await expect(
        failed.connector.readCourt("900003", one),
      ).rejects.toMatchObject({ code: "schema_changed" });
    expect(failed.fake.requests).toHaveLength(1);
    expect(failed.recording.calls).toHaveLength(2);
  });

  it("rejects missing fields and reflected bootstrap secrets without another request", async () => {
    const missingRate = { hours: [], displayHours: [] };
    const missingHours = { displayHours: [], availableForRate: true };
    const missingDisplay = { hours: [], availableForRate: true };
    for (const body of [
      missingRate,
      missingHours,
      missingDisplay,
      { ...payload(), info: "example-session" },
      { ...payload(), info: "example-token" },
    ]) {
      const h = harness([bootstrap, json(body)]);
      await expect(h.connector.readCourt("900003", one)).rejects.toMatchObject({
        code: "schema_changed",
      });
      expect(h.fake.requests).toHaveLength(2);
    }
  });

  it("rejects encoded session echoes and normalized path segments", async () => {
    const escapedBootstrap = {
      ...bootstrap,
      body: html.replace("example-session", "example/session"),
    };
    const reflected = harness([
      escapedBootstrap,
      json({ ...payload(), info: "example%2Fsession" }),
    ]);
    await expect(
      reflected.connector.readCourt("900003", one),
    ).rejects.toMatchObject({ code: "schema_changed" });
    for (const key of [".", ".."]) {
      const h = harness([
        { ...bootstrap, body: html.replace("example-session", key) },
      ]);
      await expect(h.connector.readCourt("900003", one)).rejects.toMatchObject({
        code: "schema_changed",
      });
      expect(h.fake.requests).toHaveLength(1);
    }
  });

  it("snapshots the request and configuration before awaiting bootstrap", async () => {
    const config = structuredClone(tenant);
    const headers = new Headers({ "content-type": "text/html" });
    headers.append(
      "set-cookie",
      "ExampleSession=example-token; Path=/; Secure",
    );
    let completeBootstrap!: (value: {
      status: number;
      headers: Headers;
      text: string;
      requestedAt: string;
      receivedAt: string;
    }) => void;
    const pendingBootstrap = new Promise<{
      status: number;
      headers: Headers;
      text: string;
      requestedAt: string;
      receivedAt: string;
    }>((resolve) => {
      completeBootstrap = resolve;
    });
    const request = vi.fn<HttpClient["request"]>(async (input) =>
      input.purpose === "bootstrap"
        ? pendingBootstrap
        : {
            status: 200,
            headers: new Headers({ "content-type": "application/json" }),
            text: JSON.stringify(payload()),
            requestedAt: "2026-11-04T12:00:00Z",
            receivedAt: "2026-11-04T12:00:00Z",
          },
    );
    const connector = civicRecPlatform.createConnector({
      tenant: config,
      http: { request },
      now: clock,
    });
    const dates = { start: date, end: date };
    const result = connector.readCourt("900003", dates);
    dates.start = dates.end = "2026-11-05";
    (config.parks[0]!.courts[0]!.params as Record<string, unknown>).facilityId =
      900099;
    completeBootstrap({
      status: 200,
      headers,
      text: html,
      requestedAt: "2026-11-04T12:00:00Z",
      receivedAt: "2026-11-04T12:00:00Z",
    });
    expect(await result).toMatchObject({
      court: "900003",
      startDate: date,
      endDate: date,
    });
    expect(request.mock.calls[1]![0].url.pathname).toMatch(
      /\/900003\/900004\/2026-11-04$/,
    );
  });

  it("does not rebootstrap or retry on a calendar block", async () => {
    const h = harness([bootstrap, { status: 403 }, json(payload())]);
    await expect(h.connector.readCourt("900003", one)).rejects.toMatchObject({
      code: "access_blocked",
    });
    expect(h.fake.requests).toHaveLength(2);
    expect((await h.connector.readCourt("900003", one)).complete).toBe(true);
    expect(
      h.fake.requests.filter((request) => request.url.endsWith("/catalog")),
    ).toHaveLength(1);
  });

  it("validates the allowed court and date span before any request", async () => {
    const h = harness([]);
    for (const [key, rangeValue, code] of [
      ["900099", one, "identity_mismatch"],
      ["900003", { start: date, end: "2026-11-06" }, "unsupported_time"],
      ["900003", { start: date, end: "2026-11-03" }, "unsupported_time"],
      [
        "900003",
        { start: 1 as unknown as string, end: date },
        "unsupported_time",
      ],
      [
        "900003",
        { start: "2026-02-30", end: "2026-02-30" },
        "unsupported_time",
      ],
    ] as const)
      await expect(
        h.connector.readCourt(key, rangeValue),
      ).rejects.toMatchObject({ code });
    expect(h.fake.requests).toHaveLength(0);
    expect(h.recording.calls).toEqual([]);
  });

  it("rejects invalid bootstrap or calendar chronology in the injected client", async () => {
    const headers = new Headers({ "content-type": "text/html" });
    headers.append(
      "set-cookie",
      "ExampleSession=example-token; Path=/; Secure",
    );
    for (const invalidCase of [
      "bootstrap-reversed",
      "calendar-reversed",
      "calendar-before-bootstrap",
    ]) {
      const request = vi.fn<HttpClient["request"]>(async (input) => {
        const first = input.purpose === "bootstrap";
        return {
          status: 200,
          headers,
          text: first ? html : JSON.stringify(payload()),
          requestedAt:
            invalidCase === "bootstrap-reversed" && first
              ? "2026-11-04T12:00:02Z"
              : invalidCase === "calendar-before-bootstrap" && !first
                ? "2026-11-04T11:59:59Z"
                : "2026-11-04T12:00:00Z",
          receivedAt:
            invalidCase === "calendar-reversed" && !first
              ? "2026-11-04T11:59:59Z"
              : "2026-11-04T12:00:01Z",
        };
      });
      const connector = civicRecPlatform.createConnector({
        tenant,
        http: { request },
        now: clock,
      });
      await expect(connector.readCourt("900003", one)).rejects.toMatchObject({
        code: "schema_changed",
      });
      expect(request).toHaveBeenCalledTimes(
        invalidCase === "bootstrap-reversed" ? 1 : 2,
      );
    }
  });

  it("requires bounded string timestamps from the injected client", async () => {
    const headers = new Headers({ "content-type": "text/html" });
    headers.append(
      "set-cookie",
      "ExampleSession=example-token; Path=/; Secure",
    );
    for (const requestedAt of [
      Temporal.Instant.from("2026-11-04T12:00:00Z") as unknown as string,
      "x".repeat(81),
    ]) {
      const request = vi.fn<HttpClient["request"]>(async () => ({
        status: 200,
        headers,
        text: html,
        requestedAt,
        receivedAt: "2026-11-04T12:00:00Z",
      }));
      const connector = civicRecPlatform.createConnector({
        tenant,
        http: { request },
        now: clock,
      });
      await expect(connector.readCourt("900003", one)).rejects.toMatchObject({
        code: "schema_changed",
      });
      expect(request).toHaveBeenCalledOnce();
    }
  });

  it("rejects a closing wall time in a daylight-saving gap", async () => {
    const changed = structuredClone(tenant);
    changed.timeZone = "America/New_York";
    (
      changed.parks[0]!.courts[0]!.params as Record<string, unknown>
    ).closesLocal = "02:30";
    const day = "2026-03-08";
    const empty = { hours: [], displayHours: [], availableForRate: true };
    const h = harness([bootstrap, json(empty)], changed);
    await expect(
      h.connector.readCourt("900003", { start: day, end: day }),
    ).rejects.toMatchObject({ code: "unsupported_time" });
  });
});
