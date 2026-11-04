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
    times: [],
    ...overrides,
  };
}
function envelope(rows: unknown[]): unknown {
  return {
    headers: { response_code: "0000" },
    body: { details: { resource_id: Number(court), daily_details: rows } },
  };
}
async function read(payload: unknown, start: string, end = start) {
  const response: HttpResponse = {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: JSON.stringify(payload),
    requestedAt: "2026-01-02T12:00:00.000Z",
    receivedAt: "2026-01-02T12:00:00.125Z",
  };
  const http: HttpClient = {
    async request(_request: HttpRequest) {
      return response;
    },
  };
  const connector = activeNetPlatform.createConnector({
    tenant: fixture,
    http,
    now: clock,
  });
  return connector.readCourt(court, { start, end });
}

async function expectCode(run: Promise<unknown>, code: string) {
  await expect(run).rejects.toMatchObject({ name: "ConnectorError", code });
}

describe("ActiveNet local-midnight intervals", () => {
  it("maps a same-day midnight end to the next local midnight across both clock changes", async () => {
    const expectations = [
      ["2026-10-31", "06:00", "2026-10-31T10:00:00Z", "2026-11-01T04:00:00Z"],
      ["2026-03-08", "06:00", "2026-03-08T10:00:00Z", "2026-03-09T04:00:00Z"],
      ["2026-11-01", "06:00", "2026-11-01T11:00:00Z", "2026-11-02T05:00:00Z"],
      ["2026-03-08", "00:30", "2026-03-08T05:30:00Z", "2026-03-09T04:00:00Z"],
      ["2026-11-01", "00:30", "2026-11-01T04:30:00Z", "2026-11-02T05:00:00Z"],
    ];
    for (const [date, localStart, start, end] of expectations) {
      const result = await read(
        envelope([
          sourceDay(date!, {
            times: [
              {
                available: true,
                start_time: `${localStart}:00`,
                end_time: "00:00:00",
                is_cross_day: false,
              },
            ],
          }),
        ]),
        date!,
      );
      expect(result.days[0]?.intervals).toEqual([
        { start, end, available: true },
      ]);
      expect(result.days[0]?.reasonCodes).toEqual([
        "source_closes_at_midnight",
      ]);
    }
  });

  it("preserves midnight sentinel fields in the seven-day sanitized output", async () => {
    const dates = [
      "2026-10-25",
      "2026-10-26",
      "2026-10-27",
      "2026-10-28",
      "2026-10-29",
      "2026-10-30",
      "2026-10-31",
    ];
    const rows = dates.map((date, index) =>
      index < 3
        ? sourceDay(date!, { status: 7, times: [] })
        : sourceDay(date!, {
            times: [
              {
                available: true,
                start_time: "06:00:00",
                end_time: index === 6 ? "00:00:00" : "23:00:00",
                is_cross_day: false,
              },
            ],
          }),
    );
    const result = await read(envelope(rows), dates[0]!, dates[6]!);
    expect(result.endDate).toBe(dates[6]);
    expect(result.complete).toBe(true);
    expect(
      result.days
        .slice(0, 3)
        .every(
          (day) =>
            day.visibility === "hidden_or_unavailable" &&
            day.coverage === "complete" &&
            !day.usable,
        ),
    ).toBe(true);
    expect(result.days.slice(3).every((day) => day.usable)).toBe(true);
    expect(
      (result.sanitized as { daily_details: Array<{ times: unknown[] }> })
        .daily_details[6]?.times,
    ).toEqual([
      {
        available: true,
        start_time: "06:00:00",
        end_time: "00:00:00",
        is_cross_day: false,
      },
    ]);
  });

  it("retains an unavailable midnight-ending interval as source evidence", async () => {
    const result = await read(
      envelope([
        sourceDay("2026-10-31", {
          times: [
            {
              available: false,
              start_time: "06:00:00",
              end_time: "00:00:00",
              is_cross_day: false,
            },
          ],
        }),
      ]),
      "2026-10-31",
    );
    expect(result.days[0]?.intervals).toEqual([
      {
        start: "2026-10-31T10:00:00Z",
        end: "2026-11-01T04:00:00Z",
        available: false,
      },
    ]);
  });

  it.each([
    {
      name: "zero-length midnight interval",
      date: "2026-10-31",
      start: "00:00:00",
      end: "00:00:00",
      crossDay: false,
      code: "invalid_interval",
    },
    {
      name: "backwards interval",
      date: "2026-10-31",
      start: "06:00:00",
      end: "02:00:00",
      crossDay: false,
      code: "invalid_interval",
    },
    {
      name: "non-midnight seconds after midnight",
      date: "2026-10-31",
      start: "06:00:00",
      end: "00:00:01",
      crossDay: false,
      code: "invalid_interval",
    },
    {
      name: "24-hour clock syntax",
      date: "2026-10-31",
      start: "06:00:00",
      end: "24:00:00",
      crossDay: false,
      code: "invalid_interval",
    },
    {
      name: "explicit cross-day flag",
      date: "2026-10-31",
      start: "06:00:00",
      end: "00:00:00",
      crossDay: true,
      code: "invalid_interval",
    },
    {
      name: "overlap with a late interval",
      date: "2026-10-31",
      start: "23:00:00",
      end: "23:30:00",
      crossDay: false,
      other: {
        available: true,
        start_time: "22:00:00",
        end_time: "00:00:00",
        is_cross_day: false,
      },
      code: "invalid_interval",
    },
    {
      name: "nonexistent spring-forward local time",
      date: "2026-03-08",
      start: "02:00:00",
      end: "03:00:00",
      crossDay: false,
      code: "unsupported_time",
    },
    {
      name: "ambiguous fall-back local time",
      date: "2026-11-01",
      start: "01:00:00",
      end: "02:00:00",
      crossDay: false,
      code: "unsupported_time",
    },
  ])("rejects $name", async ({ date, start, end, crossDay, other, code }) => {
    const times = [
      ...(other ? [other] : []),
      {
        available: true,
        start_time: start,
        end_time: end,
        is_cross_day: crossDay,
      },
    ];
    const payload = envelope([sourceDay(date, { times })]);
    await expectCode(read(payload, date), code);
  });
});
