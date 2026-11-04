import { Temporal } from "@js-temporal/polyfill";

export interface CivicrecHoursContext {
  facilityId: string;
  rateTypeId: string;
  date: string;
  timeZone: string;
  closure?: "active" | "inactive" | "unknown";
  reservationAction?: "enabled" | "disabled" | "unknown";
  lighting?: "unlit" | "lit_operation_unknown" | "unknown";
}

export interface CivicrecContinuousRange {
  kind: "continuous_range";
  start: string;
  end: string;
  startLocal: string;
  endLocal: string;
  rateTypeId: string;
  fragment: boolean;
  block: boolean;
  minDaysOutOverridden: boolean | null;
  description: string | null;
}

export type CivicrecHoursIssueCode =
  | "invalid_request_context"
  | "invalid_payload"
  | "hours_missing_or_invalid"
  | "display_hours_missing_or_invalid"
  | "range_limit_exceeded"
  | "empty_hours"
  | "empty_display_hours"
  | "invalid_range_shape"
  | "invalid_epoch"
  | "invalid_local_time"
  | "epoch_local_mismatch"
  | "date_mismatch"
  | "rate_mismatch"
  | "nonpositive_range"
  | "unsupported_cross_date_range"
  | "display_hours_conflict"
  | "invalid_signal"
  | "text_limit_exceeded";

export interface CivicrecHoursEvidence {
  kind: "parsed" | "partial" | "invalid";
  context: CivicrecHoursContext | null;
  /** The caller must bind a verified facility to the originating request. */
  identityBinding: "request_context_only";
  facilityIdentityVerified: false;
  /** Reported ranges never establish the unreported part of the day. */
  coverage: "reported_ranges_only" | "unknown";
  hours: CivicrecContinuousRange[];
  displayHours: CivicrecContinuousRange[];
  displayAgreement: "matching" | "conflicting" | "unknown";
  availableForRate: boolean | null;
  info: string | null;
  availableTimeDisplay: string | null;
  signals: {
    closure: NonNullable<CivicrecHoursContext["closure"]>;
    reservationAction: NonNullable<CivicrecHoursContext["reservationAction"]>;
    lighting: NonNullable<CivicrecHoursContext["lighting"]>;
  };
  issues: CivicrecHoursIssueCode[];
}

const MAX_RANGES = 256;
const MAX_TEXT = 4096;
const MAX_DESCRIPTION = 512;
const LOCAL_DATETIME =
  /^\d{4}-\d{2}-\d{2}[T ]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,9})?$/;
type JsonObject = Record<string, unknown>;

function record(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function containsControl(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return (
      code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31)
    );
  });
}

function identifier(value: unknown): string | null {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  }
  return typeof value === "string" && /^[1-9]\d{0,31}$/.test(value)
    ? value
    : null;
}

function contextFrom(value: unknown): CivicrecHoursContext | null {
  if (!record(value)) return null;
  const facilityId =
    typeof value.facilityId === "string" ? identifier(value.facilityId) : null;
  const rateTypeId =
    typeof value.rateTypeId === "string" ? identifier(value.rateTypeId) : null;
  const optionalEnum = (candidate: unknown, allowed: readonly string[]) =>
    candidate === undefined ||
    (typeof candidate === "string" && allowed.includes(candidate));
  if (
    !facilityId ||
    !rateTypeId ||
    typeof value.date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value.date) ||
    typeof value.timeZone !== "string" ||
    value.timeZone.length > 100 ||
    !/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(value.timeZone) ||
    !optionalEnum(value.closure, ["active", "inactive", "unknown"]) ||
    !optionalEnum(value.reservationAction, [
      "enabled",
      "disabled",
      "unknown",
    ]) ||
    !optionalEnum(value.lighting, ["unlit", "lit_operation_unknown", "unknown"])
  ) {
    return null;
  }
  try {
    Temporal.PlainDate.from(value.date, { overflow: "reject" });
    Temporal.Instant.from("2026-01-01T00:00:00Z").toZonedDateTimeISO(
      value.timeZone,
    );
  } catch {
    return null;
  }
  return {
    facilityId,
    rateTypeId,
    date: value.date,
    timeZone: value.timeZone,
    ...(value.closure === undefined
      ? {}
      : { closure: value.closure as CivicrecHoursContext["closure"] }),
    ...(value.reservationAction === undefined
      ? {}
      : {
          reservationAction:
            value.reservationAction as CivicrecHoursContext["reservationAction"],
        }),
    ...(value.lighting === undefined
      ? {}
      : { lighting: value.lighting as CivicrecHoursContext["lighting"] }),
  };
}

/**
 * Parse the getFacilityHours range shape without transport or eligibility
 * decisions. Space-separated and ISO-local T forms need no timezone suffix.
 * Epochs are seconds; each must round-trip through the supplied zone/local date.
 * Arrays are never joined, complemented, or upgraded to complete-day coverage.
 */
export function parseCivicrecHours(
  payload: unknown,
  context: CivicrecHoursContext,
): CivicrecHoursEvidence {
  const scope = contextFrom(context);
  const issues = new Set<CivicrecHoursIssueCode>();
  const result: CivicrecHoursEvidence = {
    kind: "invalid",
    context: scope,
    identityBinding: "request_context_only",
    facilityIdentityVerified: false,
    coverage: "unknown",
    hours: [],
    displayHours: [],
    displayAgreement: "unknown",
    availableForRate: null,
    info: null,
    availableTimeDisplay: null,
    signals: {
      closure: scope?.closure ?? "unknown",
      reservationAction: scope?.reservationAction ?? "unknown",
      lighting: scope?.lighting ?? "unknown",
    },
    issues: [],
  };
  const finish = () => ({ ...result, issues: [...issues] });
  if (!scope) {
    issues.add("invalid_request_context");
    return finish();
  }
  if (!record(payload)) {
    issues.add("invalid_payload");
    return finish();
  }

  const { date, timeZone, rateTypeId: expectedRateTypeId } = scope;

  function text(value: unknown, limit = MAX_TEXT): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string" || containsControl(value)) {
      issues.add("invalid_signal");
      return null;
    }
    if (value.length > limit) {
      issues.add("text_limit_exceeded");
      return null;
    }
    // Plain text only; callers must render as text, never trusted markup.
    return value;
  }

  function range(value: unknown): CivicrecContinuousRange | null {
    if (
      !record(value) ||
      typeof value.fragment !== "boolean" ||
      typeof value.block !== "boolean" ||
      !record(value.rateType) ||
      !identifier(value.rateType.id)
    ) {
      issues.add("invalid_range_shape");
      return null;
    }
    const rateTypeId = identifier(value.rateType.id)!;
    if (rateTypeId !== expectedRateTypeId) {
      issues.add("rate_mismatch");
      return null;
    }
    if (
      typeof value.start !== "number" ||
      !Number.isSafeInteger(value.start) ||
      typeof value.end !== "number" ||
      !Number.isSafeInteger(value.end) ||
      !Number.isSafeInteger(value.start * 1000) ||
      !Number.isSafeInteger(value.end * 1000)
    ) {
      issues.add("invalid_epoch");
      return null;
    }
    if (value.end <= value.start) {
      issues.add("nonpositive_range");
      return null;
    }
    if (
      typeof value.startDtm !== "string" ||
      !LOCAL_DATETIME.test(value.startDtm) ||
      typeof value.endDtm !== "string" ||
      !LOCAL_DATETIME.test(value.endDtm)
    ) {
      issues.add("invalid_local_time");
      return null;
    }
    let start: Temporal.Instant;
    let end: Temporal.Instant;
    let localStart: Temporal.PlainDateTime;
    let localEnd: Temporal.PlainDateTime;
    try {
      start = Temporal.Instant.fromEpochMilliseconds(value.start * 1000);
      end = Temporal.Instant.fromEpochMilliseconds(value.end * 1000);
    } catch {
      issues.add("invalid_epoch");
      return null;
    }
    try {
      localStart = Temporal.PlainDateTime.from(
        value.startDtm.replace(" ", "T"),
        {
          overflow: "reject",
        },
      );
      localEnd = Temporal.PlainDateTime.from(value.endDtm.replace(" ", "T"), {
        overflow: "reject",
      });
    } catch {
      issues.add("invalid_local_time");
      return null;
    }
    if (
      !start
        .toZonedDateTimeISO(timeZone)
        .toPlainDateTime()
        .equals(localStart) ||
      !end.toZonedDateTimeISO(timeZone).toPlainDateTime().equals(localEnd)
    ) {
      issues.add("epoch_local_mismatch");
      return null;
    }
    if (localStart.toPlainDate().toString() !== date) {
      issues.add("date_mismatch");
      return null;
    }
    if (
      localEnd.toPlainDate().toString() !== date &&
      !(
        localEnd
          .toPlainDate()
          .equals(Temporal.PlainDate.from(date).add({ days: 1 })) &&
        localEnd.toPlainTime().equals("00:00:00")
      )
    ) {
      issues.add("unsupported_cross_date_range");
      return null;
    }
    const description = text(value.description, MAX_DESCRIPTION);
    let override: boolean | null = null;
    if (
      value.minDaysOutOverridden !== undefined &&
      value.minDaysOutOverridden !== null
    ) {
      if (typeof value.minDaysOutOverridden === "boolean")
        override = value.minDaysOutOverridden;
      else issues.add("invalid_signal");
    }
    return {
      kind: "continuous_range",
      start: start.toString(),
      end: end.toString(),
      startLocal: localStart.toString(),
      endLocal: localEnd.toString(),
      rateTypeId,
      fragment: value.fragment,
      block: value.block,
      minDaysOutOverridden: override,
      description,
    };
  }

  function ranges(value: unknown, collection: "hours" | "displayHours") {
    const entries: CivicrecContinuousRange[] = [];
    if (!Array.isArray(value)) {
      issues.add(
        collection === "hours"
          ? "hours_missing_or_invalid"
          : "display_hours_missing_or_invalid",
      );
      return { entries, recognized: false, valid: false };
    }
    if (value.length > MAX_RANGES) {
      issues.add("range_limit_exceeded");
      return { entries, recognized: false, valid: false };
    }
    if (value.length === 0)
      issues.add(
        collection === "hours" ? "empty_hours" : "empty_display_hours",
      );
    for (const item of value) {
      const parsed = range(item);
      if (parsed) entries.push(parsed);
    }
    return {
      entries,
      recognized: value.length === 0 || entries.length > 0,
      valid: value.length > 0 && entries.length === value.length,
    };
  }

  const hours = ranges(payload.hours, "hours");
  const display = ranges(payload.displayHours, "displayHours");
  result.hours = hours.entries;
  result.displayHours = display.entries;
  if (result.hours.length) result.coverage = "reported_ranges_only";
  if (
    hours.valid &&
    display.valid &&
    !issues.has("invalid_signal") &&
    !issues.has("text_limit_exceeded")
  ) {
    // Compare a multiset while retaining the original individual source order.
    const fingerprints = (entries: CivicrecContinuousRange[]) =>
      entries.map((item) => JSON.stringify(item)).sort();
    result.displayAgreement =
      JSON.stringify(fingerprints(result.hours)) ===
      JSON.stringify(fingerprints(result.displayHours))
        ? "matching"
        : "conflicting";
    if (result.displayAgreement === "conflicting")
      issues.add("display_hours_conflict");
  }
  if (typeof payload.availableForRate === "boolean")
    result.availableForRate = payload.availableForRate;
  else issues.add("invalid_signal");
  result.info = text(payload.info);
  result.availableTimeDisplay = text(payload.availableTimeDisplay);
  if (result.hours.length || result.displayHours.length)
    result.kind = issues.size ? "partial" : "parsed";
  else if (hours.recognized && display.recognized) result.kind = "partial";
  return finish();
}
