import { ConnectorError } from "../../contract/errors.js";
import type {
  CourtReading,
  DayReading,
  Interval,
} from "../../contract/types.js";
import {
  localDateTimeToInstant,
  parseLocalDate,
} from "../../runtime/temporal.js";

export const parser = {
  id: "iparcs-anonymous",
  version: "iparcs-1.2",
  signature: "iparcs-calendar-v1",
} as const;

const accessResultCodes = new Set([
  "0002",
  "0006",
  "0007",
  "0009",
  "0010",
  "0011",
  "0012",
  "0021",
]);

type JsonObject = Record<string, unknown>;
type SafeTime = {
  available: boolean;
  start_time: string;
  end_time: string;
  is_cross_day: false;
};
type SafeDay = {
  date: string;
  status: number;
  check_in_only: boolean;
  check_out_only: boolean;
  times: SafeTime[];
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: ConstructorParameters<typeof ConnectorError>[0]): never {
  throw new ConnectorError(code);
}

export function validCourtKey(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d{0,9}$/.test(value);
}

export function parseDateRange(start: string, end: string): string[] {
  let first: ReturnType<typeof parseLocalDate>;
  let last: ReturnType<typeof parseLocalDate>;
  try {
    first = parseLocalDate(start);
    last = parseLocalDate(end);
  } catch {
    fail("unsupported_time");
  }
  const count = last.since(first, { largestUnit: "days" }).days + 1;
  if (count < 1 || count > 7) fail("unsupported_time");
  return Array.from({ length: count }, (_, index) =>
    first.add({ days: index }).toString(),
  );
}

function successBody(payload: unknown): JsonObject {
  if (!isObject(payload) || !isObject(payload.headers)) fail("schema_changed");
  const code = payload.headers.response_code;
  if (typeof code !== "string" || !/^\d{4}$/.test(code)) fail("schema_changed");
  if (accessResultCodes.has(code)) fail("access_blocked");
  if (code !== "0000" && code !== "0001") fail("schema_changed");
  if (!isObject(payload.body)) fail("schema_changed");
  return payload.body;
}

function parseFacilityIdentity(
  detail: unknown,
  requestedCourt: string,
): { court: string; platformLabel: string } {
  if (!isObject(detail) || !isObject(detail.general_information))
    fail("schema_changed");
  const info = detail.general_information;
  const id = info.facility_id;
  const normalizedId =
    typeof id === "number" && Number.isSafeInteger(id) && id > 0
      ? String(id)
      : typeof id === "string" && /^\d+$/.test(id)
        ? String(Number(id))
        : null;
  if (normalizedId !== requestedCourt) fail("identity_mismatch");
  const label = info.facility_name;
  if (typeof label !== "string" || !label.trim() || label.length > 200)
    fail("schema_changed");
  return { court: requestedCourt, platformLabel: label.trim() };
}

export function parseIdentity(payload: unknown, court: string) {
  const body = successBody(payload);
  if (!isObject(body.resource_detail)) fail("schema_changed");
  return parseFacilityIdentity(body.resource_detail, court);
}

function parseTime(
  value: unknown,
  date: string,
  timeZone: string,
): { intervals: Interval[]; safeTimes: SafeTime[] } {
  if (!Array.isArray(value)) fail("schema_changed");
  const intervals: Interval[] = [];
  const safeTimes: SafeTime[] = [];
  for (const item of value) {
    if (
      !isObject(item) ||
      typeof item.available !== "boolean" ||
      typeof item.is_cross_day !== "boolean" ||
      typeof item.start_time !== "string" ||
      typeof item.end_time !== "string"
    )
      fail("schema_changed");
    if (item.is_cross_day) fail("invalid_interval");
    const validClock = (clock: string) =>
      /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(clock);
    if (!validClock(item.start_time) || !validClock(item.end_time))
      fail("invalid_interval");
    const startSeconds = clockSeconds(item.start_time);
    const endSeconds = clockSeconds(item.end_time);
    const closesAtMidnight =
      item.end_time === "00:00:00" && startSeconds > endSeconds;
    if (!closesAtMidnight && endSeconds <= startSeconds)
      fail("invalid_interval");

    let start: string;
    let end: string;
    try {
      start = localDateTimeToInstant(`${date}T${item.start_time}`, timeZone);
      const endDate = closesAtMidnight
        ? parseLocalDate(date).add({ days: 1 }).toString()
        : date;
      end = localDateTimeToInstant(`${endDate}T${item.end_time}`, timeZone);
    } catch (error) {
      if (error instanceof ConnectorError && error.code === "unsupported_time")
        throw error;
      fail("unsupported_time");
    }
    intervals.push({ start, end, available: item.available });
    safeTimes.push({
      available: item.available,
      start_time: item.start_time,
      end_time: item.end_time,
      is_cross_day: false,
    });
  }
  const sorted = [...intervals].sort(
    (left, right) => Date.parse(left.start) - Date.parse(right.start),
  );
  for (let index = 1; index < sorted.length; index += 1) {
    if (Date.parse(sorted[index]!.start) < Date.parse(sorted[index - 1]!.end))
      fail("invalid_interval");
  }
  return { intervals, safeTimes };
}

function clockSeconds(value: string): number {
  const [hours, minutes, seconds] = value.split(":").map(Number);
  return hours! * 3600 + minutes! * 60 + seconds!;
}

function parseDay(
  value: unknown,
  timeZone: string,
): { day: DayReading; safeRow: SafeDay } {
  if (!isObject(value)) fail("schema_changed");
  if (typeof value.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value.date))
    fail("schema_changed");
  let date: string;
  try {
    date = parseLocalDate(value.date).toString();
  } catch {
    fail("schema_changed");
  }
  if (
    typeof value.status !== "number" ||
    !Number.isInteger(value.status) ||
    typeof value.check_in_only !== "boolean" ||
    typeof value.check_out_only !== "boolean" ||
    !Array.isArray(value.times)
  )
    fail("schema_changed");
  const safeBase = {
    date,
    status: value.status,
    check_in_only: value.check_in_only,
    check_out_only: value.check_out_only,
  };
  const emptyRow = (): SafeDay => ({ ...safeBase, times: [] });
  if (value.status === 7 && value.times.length === 0) {
    if (value.check_in_only || value.check_out_only) {
      return {
        day: {
          date,
          status: value.status,
          visibility: "unknown",
          coverage: "invalid",
          usable: false,
          reasonCodes: ["unsupported_check_mode"],
          intervals: [],
        },
        safeRow: emptyRow(),
      };
    }
    return {
      day: {
        date,
        status: value.status,
        visibility: "hidden_or_unavailable",
        coverage: "complete",
        usable: false,
        reasonCodes: ["source_hidden_or_unavailable", "occupancy_unknown"],
        intervals: [],
      },
      safeRow: emptyRow(),
    };
  }
  if (
    (value.status === 2 || value.status === 4) &&
    value.times.length === 0 &&
    !value.check_in_only &&
    !value.check_out_only
  ) {
    return {
      day: {
        date,
        status: value.status,
        visibility: "visible",
        coverage: "complete",
        usable: true,
        reasonCodes: [
          value.status === 4 ? "source_fully_booked" : "source_schedule_closed",
        ],
        intervals: [],
      },
      safeRow: emptyRow(),
    };
  }
  if (value.status !== 0 && value.status !== 1) {
    return {
      day: {
        date,
        status: value.status,
        visibility: "unknown",
        coverage: "invalid",
        usable: false,
        reasonCodes: ["unknown_source_status"],
        intervals: [],
      },
      safeRow: emptyRow(),
    };
  }
  if (value.check_in_only || value.check_out_only) {
    return {
      day: {
        date,
        status: value.status,
        visibility: "unknown",
        coverage: "invalid",
        usable: false,
        reasonCodes: ["unsupported_check_mode"],
        intervals: [],
      },
      safeRow: emptyRow(),
    };
  }
  const parsed = parseTime(value.times, date, timeZone);
  return {
    day: {
      date,
      status: value.status,
      visibility: "visible",
      coverage: "complete",
      usable: true,
      reasonCodes: parsed.safeTimes.some((time) => time.end_time === "00:00:00")
        ? ["source_closes_at_midnight"]
        : [],
      intervals: parsed.intervals,
    },
    safeRow: { ...safeBase, times: parsed.safeTimes },
  };
}

export function buildReading(
  payload: unknown,
  court: string,
  start: string,
  end: string,
  timeZone: string,
  origin: string,
  basePath: string,
): Omit<
  CourtReading,
  "platform" | "tenant" | "court" | "observedAt" | "parser" | "attribution"
> {
  const expectedDates = parseDateRange(start, end);
  const body = successBody(payload);
  if (!isObject(body.details) || !Array.isArray(body.details.daily_details))
    fail("schema_changed");
  const returnedId = body.details.resource_id;
  if (
    typeof returnedId !== "number" ||
    !Number.isSafeInteger(returnedId) ||
    String(returnedId) !== court
  )
    fail("identity_mismatch");
  const parsed = body.details.daily_details.map((item) =>
    parseDay(item, timeZone),
  );
  const expected = new Set(expectedDates);
  const counts = new Map<string, number>();
  for (const { day } of parsed)
    counts.set(day.date, (counts.get(day.date) ?? 0) + 1);
  const coverageIsExact =
    parsed.length === expected.size &&
    parsed.every(({ day }) => expected.has(day.date)) &&
    expectedDates.every((date) => counts.get(date) === 1);
  const days = parsed.map(({ day }) => {
    const duplicate = (counts.get(day.date) ?? 0) > 1;
    const inRange = expected.has(day.date);
    if (duplicate || !inRange) {
      return {
        ...day,
        coverage: "invalid" as const,
        usable: false,
        intervals: [],
        reasonCodes: [
          ...day.reasonCodes,
          ...(duplicate ? ["duplicate_source_date"] : []),
          ...(!inRange ? ["date_out_of_range"] : []),
          "date_coverage_incomplete",
        ],
      };
    }
    if (!coverageIsExact) {
      return {
        ...day,
        coverage:
          day.coverage === "invalid"
            ? ("invalid" as const)
            : ("partial" as const),
        usable: false,
        reasonCodes: [...day.reasonCodes, "date_coverage_incomplete"],
      };
    }
    return day;
  });
  const complete =
    coverageIsExact && days.every((day) => day.coverage === "complete");
  const normalizedDays = complete
    ? days
    : days.map((day) => ({
        ...day,
        usable: false,
        coverage:
          day.coverage === "complete" ? ("partial" as const) : day.coverage,
        reasonCodes: [...day.reasonCodes, "range_incomplete"],
      }));
  const sourceUrl = calendarUrl(origin, basePath, court, start, end);
  const safeRows = parsed.map(({ safeRow }) => safeRow);
  return {
    startDate: start,
    endDate: end,
    complete,
    sourceUrl,
    days: normalizedDays,
    sanitized: {
      resource_id: Number(court),
      daily_details: safeRows,
    },
  };
}

export function calendarUrl(
  origin: string,
  basePath: string,
  court: string,
  start: string,
  end: string,
): string {
  const url = new URL(
    `${origin}${basePath}/rest/reservation/resource/availability/daily/${court}`,
  );
  url.search = new URLSearchParams({
    start_date: start,
    end_date: end,
    customer_id: "0",
    company_id: "0",
    locale: "en-US",
  }).toString();
  return url.toString();
}
