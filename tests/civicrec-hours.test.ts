import { describe, expect, it } from "vitest";
import { Temporal } from "@js-temporal/polyfill";
import { parseCivicrecHours } from "../packages/connectors/src/platforms/civicrec/hours.js";

const context = {
  facilityId: "900003",
  rateTypeId: "900004",
  date: "2026-11-04",
  timeZone: "UTC",
};
function item(start = "08:00", end = "10:00") {
  return {
    start: Date.parse(`2026-11-04T${start}:00Z`) / 1000,
    end: Date.parse(`2026-11-04T${end}:00Z`) / 1000,
    startDtm: `2026-11-04 ${start}:00`,
    endDtm: `2026-11-04 ${end}:00`,
    fragment: false,
    block: false,
    rateType: { id: "900004" },
  };
}
function payload(rows: unknown[] = [item()]) {
  return {
    hours: rows,
    displayHours: structuredClone(rows),
    availableForRate: true,
  };
}

describe("CivicRec reported hours parser", () => {
  it("retains source order, flags, duplicates and independently reported gaps", () => {
    const rows = [
      item("12:00", "13:00"),
      { ...item(), fragment: true },
      item("08:00", "10:00"),
      { ...item("15:00", "16:00"), block: true },
    ];
    const source = payload(rows);
    source.displayHours.reverse();
    const snapshot = structuredClone(source);
    const result = parseCivicrecHours(source, context);
    expect(result).toMatchObject({
      kind: "parsed",
      displayAgreement: "matching",
      coverage: "reported_ranges_only",
      identityBinding: "request_context_only",
      facilityIdentityVerified: false,
      issues: [],
    });
    expect(
      result.hours.map((row) => [row.start, row.fragment, row.block]),
    ).toEqual([
      ["2026-11-04T12:00:00Z", false, false],
      ["2026-11-04T08:00:00Z", true, false],
      ["2026-11-04T08:00:00Z", false, false],
      ["2026-11-04T15:00:00Z", false, true],
    ]);
    expect(source).toEqual(snapshot);
  });

  it("reports invalid contexts, missing collections and recognized empty arrays", () => {
    expect(
      parseCivicrecHours({}, { ...context, date: "2026-02-30" }),
    ).toMatchObject({ kind: "invalid", issues: ["invalid_request_context"] });
    expect(parseCivicrecHours(null, context)).toMatchObject({
      kind: "invalid",
      issues: ["invalid_payload"],
    });
    expect(
      parseCivicrecHours(
        { hours: null, displayHours: [], availableForRate: true },
        context,
      ).issues,
    ).toEqual(["hours_missing_or_invalid", "empty_display_hours"]);
    expect(
      parseCivicrecHours(
        { hours: [], displayHours: null, availableForRate: true },
        context,
      ).issues,
    ).toEqual(["empty_hours", "display_hours_missing_or_invalid"]);
    expect(
      parseCivicrecHours(
        { hours: [], displayHours: [], availableForRate: true },
        context,
      ),
    ).toMatchObject({
      kind: "partial",
      coverage: "unknown",
      issues: ["empty_hours", "empty_display_hours"],
      availableForRate: true,
    });
  });

  it("distinguishes range validation failures without coercing source values", () => {
    const original = item();
    const cases: [unknown, string][] = [
      [{ ...original, fragment: "false" }, "invalid_range_shape"],
      [{ ...original, rateType: { id: "900005" } }, "rate_mismatch"],
      [{ ...original, start: 1.5 }, "invalid_epoch"],
      [{ ...original, end: original.start }, "nonpositive_range"],
      [{ ...original, startDtm: "not-a-time" }, "invalid_local_time"],
      [
        { ...original, startDtm: "2026-11-04 08:01:00" },
        "epoch_local_mismatch",
      ],
      [
        {
          ...original,
          start: Date.parse("2026-11-05T08:00:00Z") / 1000,
          end: Date.parse("2026-11-05T10:00:00Z") / 1000,
          startDtm: "2026-11-05 08:00:00",
          endDtm: "2026-11-05 10:00:00",
        },
        "date_mismatch",
      ],
      [
        {
          ...original,
          start: Date.parse("2026-11-04T23:00:00Z") / 1000,
          end: Date.parse("2026-11-05T00:30:00Z") / 1000,
          startDtm: "2026-11-04 23:00:00",
          endDtm: "2026-11-05 00:30:00",
        },
        "unsupported_cross_date_range",
      ],
    ];
    for (const [bad, issue] of cases) {
      const result = parseCivicrecHours(
        { hours: [bad], displayHours: [bad], availableForRate: true },
        context,
      );
      expect(result.issues).toEqual([issue]);
      expect(result.kind).toBe("invalid");
      expect(result.hours).toEqual([]);
    }
    const mixed = parseCivicrecHours(
      {
        hours: [item(), { ...item(), start: 1.5 }],
        displayHours: [item()],
        availableForRate: true,
      },
      context,
    );
    expect(mixed).toMatchObject({
      kind: "partial",
      displayAgreement: "unknown",
      issues: ["invalid_epoch"],
    });
    expect(mixed.hours).toHaveLength(1);
  });

  it("checks comparison, signals and size bounds independently", () => {
    const conflict = payload();
    conflict.displayHours = [item("09:00", "10:00")];
    expect(parseCivicrecHours(conflict, context)).toMatchObject({
      kind: "partial",
      displayAgreement: "conflicting",
      issues: ["display_hours_conflict"],
    });
    expect(
      parseCivicrecHours(
        { ...payload(), availableForRate: null, info: "\u0001" },
        context,
      ),
    ).toMatchObject({
      kind: "partial",
      availableForRate: null,
      issues: ["invalid_signal"],
    });
    const bounded = Array.from({ length: 256 }, () => item());
    expect(parseCivicrecHours(payload(bounded), context)).toMatchObject({
      kind: "parsed",
      issues: [],
    });
    expect(
      parseCivicrecHours(payload([...bounded, item()]), context).issues,
    ).toContain("range_limit_exceeded");
    expect(
      parseCivicrecHours({ ...payload(), info: "x".repeat(4097) }, context)
        .issues,
    ).toContain("text_limit_exceeded");
    const noisy = { ...item(), description: "x".repeat(513) };
    expect(parseCivicrecHours(payload([noisy]), context).issues).toContain(
      "text_limit_exceeded",
    );
  });

  it("preserves optional flags and text as data without inferring eligibility", () => {
    const original = {
      ...item("08:05", "10:05"),
      rateType: { id: 900004 },
      minDaysOutOverridden: false,
      description: "example text",
    };
    const result = parseCivicrecHours(
      { ...payload([original]), info: "example instruction-like text\n" },
      context,
    );
    expect(result).toMatchObject({
      kind: "parsed",
      availableForRate: true,
      signals: {
        closure: "unknown",
        reservationAction: "unknown",
        lighting: "unknown",
      },
      issues: [],
      hours: [
        {
          start: "2026-11-04T08:05:00Z",
          minDaysOutOverridden: false,
          description: "example text",
          rateTypeId: "900004",
        },
      ],
    });
    const withSignals = parseCivicrecHours(payload([original]), {
      ...context,
      closure: "active",
      reservationAction: "disabled",
      lighting: "unlit",
    });
    expect(withSignals.signals).toEqual({
      closure: "active",
      reservationAction: "disabled",
      lighting: "unlit",
    });
    const badOverride = parseCivicrecHours(
      payload([{ ...original, minDaysOutOverridden: "false" }]),
      context,
    );
    expect(badOverride).toMatchObject({
      kind: "partial",
      issues: ["invalid_signal"],
    });
  });

  it("accepts an endpoint at next midnight and rejects a later endpoint", () => {
    const end = {
      ...item("23:00", "23:30"),
      end: Date.parse("2026-11-05T00:00:00Z") / 1000,
      endDtm: "2026-11-05 00:00:00",
    };
    expect(parseCivicrecHours(payload([end]), context)).toMatchObject({
      kind: "parsed",
      issues: [],
    });
    const later = { ...end, end: end.end + 60, endDtm: "2026-11-05 00:01:00" };
    expect(parseCivicrecHours(payload([later]), context).issues).toContain(
      "unsupported_cross_date_range",
    );
  });

  it("checks daylight-saving local and epoch agreement without discarding a real repeated hour", () => {
    const zone = "America/New_York";
    const start = Temporal.ZonedDateTime.from(
      { timeZone: zone, year: 2026, month: 11, day: 1, hour: 1, minute: 15 },
      { disambiguation: "earlier" },
    );
    const end = Temporal.ZonedDateTime.from(
      { timeZone: zone, year: 2026, month: 11, day: 1, hour: 1, minute: 45 },
      { disambiguation: "later" },
    );
    const repeated = {
      ...item(),
      start: start.epochMilliseconds / 1000,
      end: end.epochMilliseconds / 1000,
      startDtm: "2026-11-01 01:15:00",
      endDtm: "2026-11-01 01:45:00",
    };
    expect(
      parseCivicrecHours(payload([repeated]), {
        ...context,
        date: "2026-11-01",
        timeZone: zone,
      }),
    ).toMatchObject({ kind: "parsed", issues: [] });
    const gap = {
      ...repeated,
      start: Date.parse("2026-03-08T07:30:00Z") / 1000,
      end: Date.parse("2026-03-08T08:30:00Z") / 1000,
      startDtm: "2026-03-08 02:30:00",
      endDtm: "2026-03-08 04:30:00",
    };
    expect(
      parseCivicrecHours(payload([gap]), {
        ...context,
        date: "2026-03-08",
        timeZone: zone,
      }).issues,
    ).toContain("epoch_local_mismatch");
  });
});
