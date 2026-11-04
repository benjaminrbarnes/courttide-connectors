import { readFileSync } from "node:fs";
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  TenantConfig,
} from "../../packages/connectors/src/contract/types.js";
import { activeNetPlatform } from "../../packages/connectors/src/platforms/activenet/index.js";
import { describe, expect, it } from "vitest";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../examples/activenet/tenant.json", import.meta.url),
    "utf8",
  ),
) as TenantConfig<{ basePath: string }, Record<string, never>>;
const court = "900001";
const clock = () => new Date("2026-01-02T12:34:56.789Z");

function sourceDay(
  date: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    date,
    status: 0,
    check_in_only: false,
    check_out_only: false,
    display_note: "synthetic-only",
    times: [
      {
        available: true,
        start_time: "09:00:00",
        end_time: "11:00:00",
        is_cross_day: false,
        slot_marker: "synthetic-redaction-check",
      },
    ],
    row_marker: "synthetic-row-marker",
    ...overrides,
  };
}

function envelope(
  rows: unknown[],
  options: { code?: string; resourceId?: number } = {},
): unknown {
  return {
    headers: { response_code: options.code ?? "0000" },
    body: {
      details: {
        resource_id: options.resourceId ?? Number(court),
        daily_details: rows,
      },
    },
  };
}

function makeConnector(payload: unknown, tenant = fixture) {
  const calls: HttpRequest[] = [];
  const response: HttpResponse = {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: JSON.stringify(payload),
    requestedAt: "2026-01-02T12:00:00.000Z",
    receivedAt: "2026-01-02T12:00:00.125Z",
  };
  const http: HttpClient = {
    async request(request) {
      calls.push(request);
      return response;
    },
  };
  const connector = activeNetPlatform.createConnector({
    tenant,
    http,
    now: clock,
  });
  return { connector, calls };
}

async function read(payload: unknown, start = "2026-01-02", end = start) {
  const { connector, calls } = makeConnector(payload);
  return {
    result: await connector.readCourt(court, { start, end }),
    calls,
  };
}

async function expectCode(run: Promise<unknown>, code: string): Promise<void> {
  await expect(run).rejects.toMatchObject({
    name: "ConnectorError",
    code,
  });
}

describe("ActiveNet platform parsing", () => {
  it("reads a complete inclusive seven-day range and removes unrecognized fields", async () => {
    const rows = Array.from({ length: 7 }, (_, index) =>
      sourceDay(`2026-01-${String(index + 2).padStart(2, "0")}`, {
        status: index === 1 ? 1 : 0,
        times: [
          {
            available: index !== 2,
            start_time: "09:00:00",
            end_time: "11:00:00",
            is_cross_day: false,
            slot_marker: "synthetic-slot-secret",
          },
        ],
      }),
    );
    const { result, calls } = await read(
      envelope(rows),
      "2026-01-02",
      "2026-01-08",
    );
    expect(result.complete).toBe(true);
    expect(result.days).toHaveLength(7);
    expect(result.days[0]).toMatchObject({
      status: 0,
      visibility: "visible",
      coverage: "complete",
      usable: true,
    });
    expect(result.days[2]?.intervals[0]?.available).toBe(false);
    expect(result.days[0]?.intervals[0]?.start).toBe("2026-01-02T14:00:00Z");
    expect(result.sourceUrl).toBe(
      "https://example.activecommunities.com/exampleparks/rest/reservation/resource/availability/daily/900001?start_date=2026-01-02&end_date=2026-01-08&customer_id=0&company_id=0&locale=en-US",
    );
    expect(JSON.stringify(result.sanitized)).not.toMatch(
      /synthetic-slot-secret|row_marker|display_note|slot_marker/,
    );
    expect(result.sanitized).toEqual({
      resource_id: 900001,
      daily_details: rows.map((row) => ({
        date: row.date,
        status: row.status,
        check_in_only: false,
        check_out_only: false,
        times: [
          {
            available: row.status === 1 || row.date !== "2026-01-04",
            start_time: "09:00:00",
            end_time: "11:00:00",
            is_cross_day: false,
          },
        ],
      })),
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      court,
      purpose: "calendar",
      method: "GET",
      headers: { accept: "application/json" },
      expect: "json",
    });
    expect(result.observedAt).toBe("2026-01-02T12:34:56.789Z");
    expect(result.parser).toEqual({
      id: "iparcs-anonymous",
      version: "iparcs-1.2",
      signature: "iparcs-calendar-v1",
    });
  });

  it("recognizes closed, fully booked and hidden rows without inventing intervals", async () => {
    const { result } = await read(
      envelope([
        sourceDay("2026-01-02", { status: 2, times: [] }),
        sourceDay("2026-01-03", { status: 4, times: [] }),
        sourceDay("2026-01-04", { status: 7, times: [] }),
        sourceDay("2026-01-05", { status: 42, times: [] }),
      ]),
      "2026-01-02",
      "2026-01-05",
    );
    expect(result.complete).toBe(false);
    expect(result.days[0]).toMatchObject({
      usable: false,
      visibility: "visible",
      reasonCodes: ["source_schedule_closed", "range_incomplete"],
      intervals: [],
    });
    expect(result.days[1]).toMatchObject({
      usable: false,
      reasonCodes: ["source_fully_booked", "range_incomplete"],
      intervals: [],
    });
    expect(result.days[2]).toMatchObject({
      coverage: "partial",
      visibility: "hidden_or_unavailable",
      reasonCodes: [
        "source_hidden_or_unavailable",
        "occupancy_unknown",
        "range_incomplete",
      ],
      intervals: [],
    });
    expect(result.days[3]?.reasonCodes).toEqual([
      "unknown_source_status",
      "range_incomplete",
    ]);
  });

  it("treats contradictory all-day shapes as unknown and unusable", async () => {
    const { result } = await read(
      envelope([
        sourceDay("2026-01-02", { status: 2 }),
        sourceDay("2026-01-03", { status: 4 }),
        sourceDay("2026-01-04", {
          status: 2,
          times: [],
          check_in_only: true,
        }),
        sourceDay("2026-01-05", {
          status: 4,
          times: [],
          check_out_only: true,
        }),
      ]),
      "2026-01-02",
      "2026-01-05",
    );
    expect(result.complete).toBe(false);
    for (const day of result.days) {
      expect(day).toMatchObject({
        visibility: "unknown",
        coverage: "invalid",
        usable: false,
        intervals: [],
        reasonCodes: ["unknown_source_status", "range_incomplete"],
      });
    }
  });

  it("keeps recognized hidden coverage complete and visible rows usable", async () => {
    const { result } = await read(
      envelope([
        sourceDay("2026-01-02", { status: 7, times: [] }),
        sourceDay("2026-01-03"),
      ]),
      "2026-01-02",
      "2026-01-03",
    );
    expect(result.complete).toBe(true);
    expect(result.days[0]).toMatchObject({
      coverage: "complete",
      visibility: "hidden_or_unavailable",
      usable: false,
      intervals: [],
    });
    expect(result.days[1]).toMatchObject({
      coverage: "complete",
      visibility: "visible",
      usable: true,
    });
  });

  it("marks partial, duplicate and out-of-range date coverage unusable", async () => {
    const cases = [
      [sourceDay("2026-01-02"), sourceDay("2026-01-04")],
      [
        sourceDay("2026-01-02"),
        sourceDay("2026-01-02"),
        sourceDay("2026-01-03"),
      ],
      [
        sourceDay("2026-01-02"),
        sourceDay("2026-01-03"),
        sourceDay("2026-01-05"),
      ],
    ];
    for (const rows of cases) {
      const { result } = await read(envelope(rows), "2026-01-02", "2026-01-03");
      expect(result.complete).toBe(false);
      expect(result.days.every((day) => !day.usable)).toBe(true);
      expect(
        result.days.every((day) =>
          day.reasonCodes.includes("date_coverage_incomplete"),
        ),
      ).toBe(true);
      expect(
        result.days.every((day) =>
          ["partial", "invalid"].includes(day.coverage),
        ),
      ).toBe(true);
      expect(
        result.days
          .filter((day) => day.reasonCodes.includes("duplicate_source_date"))
          .every((day) => day.intervals.length === 0),
      ).toBe(true);
    }
  });

  it("fails closed on malformed times, explicit cross-day times and check modes", async () => {
    const invalid = [
      {
        row: sourceDay("2026-01-02", {
          times: [
            {
              available: "true",
              start_time: "09:00:00",
              end_time: "11:00:00",
              is_cross_day: false,
            },
          ],
        }),
        code: "schema_changed",
      },
      {
        row: sourceDay("2026-01-02", {
          times: [
            {
              available: true,
              start_time: "09:00:00",
              end_time: "11:00:00",
              is_cross_day: true,
            },
          ],
        }),
        code: "invalid_interval",
      },
      {
        row: sourceDay("2026-01-02", {
          times: [
            {
              available: true,
              start_time: "11:00:00",
              end_time: "09:00:00",
              is_cross_day: false,
            },
          ],
        }),
        code: "invalid_interval",
      },
    ];
    for (const { row, code } of invalid)
      await expectCode(
        read(envelope([row])).then(({ result }) => result),
        code,
      );
    const { result } = await read(
      envelope([sourceDay("2026-01-02", { check_in_only: true })]),
    );
    expect(result.days[0]).toMatchObject({
      visibility: "unknown",
      usable: false,
      reasonCodes: ["unsupported_check_mode", "range_incomplete"],
    });
  });

  it("rejects duplicate and overlapping intervals but accepts touching intervals", async () => {
    const time = (start_time: string, end_time: string) => ({
      available: true,
      start_time,
      end_time,
      is_cross_day: false,
    });
    const adjacent = await read(
      envelope([
        sourceDay("2026-01-02", {
          times: [time("09:00:00", "10:00:00"), time("10:00:00", "11:00:00")],
        }),
      ]),
    );
    expect(adjacent.result.days[0]?.intervals).toHaveLength(2);
    expect(adjacent.result.days[0]?.intervals[0]?.end).toBe(
      adjacent.result.days[0]?.intervals[1]?.start,
    );
    for (const times of [
      [time("09:00:00", "10:00:00"), time("09:00:00", "10:00:00")],
      [time("09:00:00", "10:30:00"), time("10:00:00", "11:00:00")],
    ]) {
      await expectCode(
        read(envelope([sourceDay("2026-01-02", { times })])).then(
          ({ result }) => result,
        ),
        "invalid_interval",
      );
    }
  });

  it("rejects nonexistent and ambiguous local wall times", async () => {
    for (const [date, start] of [
      ["2026-03-08", "02:30:00"],
      ["2026-11-01", "01:30:00"],
    ]) {
      await expectCode(
        read(
          envelope([
            sourceDay(date!, {
              times: [
                {
                  available: true,
                  start_time: start,
                  end_time: "03:30:00",
                  is_cross_day: false,
                },
              ],
            }),
          ]),
          date!,
        ).then(({ result }) => result),
        "unsupported_time",
      );
    }
  });

  it("uses the configured tenant time zone", async () => {
    const tenant = { ...fixture, timeZone: "UTC" };
    const { connector } = makeConnector(
      envelope([sourceDay("2026-01-02")]),
      tenant,
    );
    const result = await connector.readCourt(court, {
      start: "2026-01-02",
      end: "2026-01-02",
    });
    expect(result.days[0]?.intervals[0]?.start).toBe("2026-01-02T09:00:00Z");
  });

  it("rejects malformed calendar-row dates as schema changes", async () => {
    await expectCode(
      read(envelope([sourceDay("2026-02-30")]), "2026-02-30").then(
        ({ result }) => result,
      ),
      "unsupported_time",
    );
    await expectCode(
      read(envelope([sourceDay("2026-02-30")]), "2026-02-28").then(
        ({ result }) => result,
      ),
      "schema_changed",
    );
  });
});
