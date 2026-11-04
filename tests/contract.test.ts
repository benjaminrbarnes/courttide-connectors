import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ATTRIBUTION,
  CapabilitiesSchema,
  ConnectorError,
  CourtReadingSchema,
  CourtSelectionSchema,
  GateDeferred,
  GateOutcomeSchema,
  TenantConfigSchema,
  readingSchema,
} from "../packages/connectors/src/index.js";

const config = JSON.parse(
  readFileSync("examples/tenants/example.json", "utf8"),
);
const fullContext = {
  shape: "full_calendar" as const,
  timeZone: "UTC",
  parkSlug: "example-park",
};
const evidence = {
  kind: "continuous_ranges" as const,
  scope: "reported_ranges_only" as const,
  startIncrementMinutes: 15 as const,
  startAnchor: "range_start" as const,
  minimumOccupiedMinutes: 60,
  durationStepMinutes: 15,
};
function reading() {
  return {
    platform: "example",
    tenant: "exampleparks",
    court: "900001",
    startDate: "2026-11-04",
    endDate: "2026-11-04",
    complete: true,
    observedAt: "2026-11-04T09:00:00.000Z",
    sourceUrl: "https://example.invalid/",
    days: [
      {
        date: "2026-11-04",
        status: 200,
        visibility: "visible" as
          "visible" | "hidden_or_unavailable" | "unknown",
        coverage: "complete" as "complete" | "partial" | "invalid",
        usable: true,
        reasonCodes: [] as string[],
        intervals: [
          {
            start: "2026-11-04T10:00:00.000Z",
            end: "2026-11-04T11:00:00.000Z",
            available: false,
          },
        ],
        evidence: undefined as typeof evidence | undefined,
      },
    ],
    sanitized: {},
    parser: { id: "example", version: "1", signature: "example" },
    attribution: {
      ...ATTRIBUTION,
      parkUrl: "https://courttide.com/courts/example-park",
    },
  };
}

describe("contract schemas", () => {
  it("validates optional retryability on failed gate outcomes", () => {
    expect(
      GateOutcomeSchema.safeParse({
        ok: false,
        error: "http_error",
        retryable: true,
      }).success,
    ).toBe(true);
    expect(
      GateOutcomeSchema.safeParse({ ok: false, error: "http_error" }).success,
    ).toBe(true);
    expect(
      GateOutcomeSchema.safeParse({ ok: true, retryable: false }).success,
    ).toBe(false);
    expect(
      GateOutcomeSchema.safeParse({
        ok: false,
        error: "http_error",
        retryable: "true",
      }).success,
    ).toBe(false);
  });

  it("accepts the synthetic config and keeps generated schemas synchronized", () => {
    expect(TenantConfigSchema.safeParse(config).success).toBe(true);
    for (const file of readdirSync("examples/tenants")) {
      expect(
        TenantConfigSchema.safeParse(
          JSON.parse(readFileSync(`examples/tenants/${file}`, "utf8")),
        ).success,
      ).toBe(true);
    }
    const generated = z.toJSONSchema(TenantConfigSchema, { io: "input" });
    expect(
      JSON.parse(readFileSync("schema/tenant.schema.json", "utf8")),
    ).toEqual(generated);
    expect(
      JSON.parse(
        readFileSync("packages/connectors/schema/tenant.schema.json", "utf8"),
      ),
    ).toEqual(generated);
    expect(
      TenantConfigSchema.safeParse({ ...config, timeZone: "invalid" }).success,
    ).toBe(false);
    expect(
      TenantConfigSchema.safeParse({
        ...config,
        origin: "https://example.invalid/path",
      }).success,
    ).toBe(false);
    expect(
      TenantConfigSchema.safeParse({ ...config, schemaVersion: "2" }).success,
    ).toBe(false);
    expect(CourtSelectionSchema.safeParse([]).success).toBe(false);
    expect(CourtSelectionSchema.safeParse(["900001", "900001"]).success).toBe(
      false,
    );
  });

  it("enforces capabilities and named errors", () => {
    const capabilities = {
      auth: "none",
      shape: "full_calendar",
      maxDaysPerRead: 1,
      leaseScope: "per_read",
      requests: { perRead: 1, perSessionBootstrap: 0 },
      minimumGapMs: 10000,
      identity: "none",
      bookingWrites: false,
    };
    expect(CapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(
      CapabilitiesSchema.safeParse({ ...capabilities, bookingWrites: true })
        .success,
    ).toBe(false);
    expect(
      CapabilitiesSchema.safeParse({ ...capabilities, minimumGapMs: 9999 })
        .success,
    ).toBe(false);
    expect(new ConnectorError("schema_changed").name).toBe("ConnectorError");
    expect(new GateDeferred("2026-11-04T00:00:00.000Z", "pacing").name).toBe(
      "GateDeferred",
    );
  });

  it("rejects unusable interval states except retained partial-calendar evidence", () => {
    expect(CourtReadingSchema.safeParse(reading()).success).toBe(true);
    for (const change of [
      { usable: false },
      { visibility: "hidden_or_unavailable" },
      { visibility: "unknown" },
      { coverage: "partial" },
      { coverage: "invalid" },
    ]) {
      const value = reading();
      Object.assign(value.days[0]!, change);
      expect(CourtReadingSchema.safeParse(value).success).toBe(false);
    }
    const partial = reading();
    Object.assign(partial.days[0]!, { coverage: "partial", evidence });
    partial.days[0]!.intervals[0]!.available = true;
    expect(
      readingSchema({ ...fullContext, shape: "continuous_ranges" }).safeParse(
        partial,
      ).success,
    ).toBe(true);
    delete partial.days[0]!.evidence;
    expect(CourtReadingSchema.safeParse(partial).success).toBe(false);
  });

  it("retains explicit missing-date evidence without making a partial calendar usable", () => {
    const value = reading();
    value.endDate = "2026-11-05";
    value.complete = false;
    const day = value.days[0]!;
    day.coverage = "partial";
    day.usable = false;
    day.reasonCodes.push("date_coverage_incomplete", "range_incomplete");
    day.intervals.push({
      start: "2026-11-04T11:00:00.000Z",
      end: "2026-11-04T12:00:00.000Z",
      available: true,
    });
    const parsed = readingSchema(fullContext).parse(value);
    expect(
      parsed.days[0]!.intervals.map((interval) => interval.available),
    ).toEqual([false, true]);
    expect(parsed.days[0]!.usable).toBe(false);
    expect(
      parsed.days.filter(
        (candidate) => candidate.usable && candidate.coverage === "complete",
      ),
    ).toEqual([]);
    day.usable = true;
    expect(readingSchema(fullContext).safeParse(value).success).toBe(false);
    day.evidence = evidence;
    expect(readingSchema(fullContext).safeParse(value).success).toBe(false);
  });

  it("enforces shape, attribution, interval ordering and local midnight including DST", () => {
    const withEvidence = reading();
    withEvidence.days[0]!.evidence = evidence;
    expect(readingSchema(fullContext).safeParse(withEvidence).success).toBe(
      false,
    );
    const ranges = reading();
    Object.assign(ranges.days[0]!, { coverage: "partial", evidence });
    expect(
      readingSchema({ ...fullContext, shape: "continuous_ranges" }).safeParse(
        ranges,
      ).success,
    ).toBe(false);
    expect(
      readingSchema({ ...fullContext, parkSlug: undefined }).safeParse(
        reading(),
      ).success,
    ).toBe(false);

    const dst = reading();
    dst.startDate = dst.endDate = dst.days[0]!.date = "2026-03-08";
    dst.days[0]!.intervals = [
      {
        start: "2026-03-08T06:00:00.000Z",
        end: "2026-03-09T04:00:00.000Z",
        available: true,
      },
    ];
    const context = { ...fullContext, timeZone: "America/New_York" };
    expect(readingSchema(context).safeParse(dst).success).toBe(true);
    expect(
      readingSchema({ ...context, timeZone: "invalid" }).safeParse({
        ...dst,
        days: [],
      }).success,
    ).toBe(false);
    dst.days[0]!.intervals[0]!.end = "2026-03-09T04:00:00.001Z";
    expect(readingSchema(context).safeParse(dst).success).toBe(false);
    const overlap = reading();
    overlap.days[0]!.intervals.push({
      start: "2026-11-04T10:30:00.000Z",
      end: "2026-11-04T11:30:00.000Z",
      available: true,
    });
    expect(CourtReadingSchema.safeParse(overlap).success).toBe(false);
    overlap.days[0]!.intervals[1]!.start = "2026-11-04T11:00:00.000Z";
    expect(CourtReadingSchema.safeParse(overlap).success).toBe(true);
    overlap.days[0]!.intervals.reverse();
    expect(CourtReadingSchema.safeParse(overlap).success).toBe(true);
  });

  it("never labels reported-only ranges as complete, even when unusable", () => {
    const value = reading();
    value.complete = false;
    value.days[0]!.usable = false;
    value.days[0]!.intervals = [];
    const context = { ...fullContext, shape: "continuous_ranges" as const };
    expect(readingSchema(context).safeParse(value).success).toBe(false);
    value.days[0]!.coverage = "invalid";
    expect(readingSchema(context).safeParse(value).success).toBe(true);
    value.days[0]!.coverage = "partial";
    expect(readingSchema(context).safeParse(value).success).toBe(true);
  });

  it("retains explicitly overlapping and duplicate reported ranges only", () => {
    const value = reading();
    const day = value.days[0]!;
    day.coverage = "partial";
    day.evidence = evidence;
    day.intervals = [
      {
        start: "2026-11-04T08:00:00.000Z",
        end: "2026-11-04T10:00:00.000Z",
        available: true,
      },
      {
        start: "2026-11-04T09:00:00.000Z",
        end: "2026-11-04T11:00:00.000Z",
        available: true,
      },
      {
        start: "2026-11-04T08:00:00.000Z",
        end: "2026-11-04T10:00:00.000Z",
        available: true,
      },
    ];
    const context = { ...fullContext, shape: "continuous_ranges" as const };
    expect(readingSchema(context).parse(value).days[0]!.intervals).toEqual(
      day.intervals,
    );
    day.intervals[0]!.available = false;
    expect(readingSchema(context).safeParse(value).success).toBe(false);
    day.intervals[0]!.available = true;
    day.visibility = "unknown";
    day.usable = false;
    expect(readingSchema(context).safeParse(value).success).toBe(false);
    day.visibility = "visible";
    day.usable = true;
    day.coverage = "complete";
    day.evidence = undefined;
    expect(readingSchema(fullContext).safeParse(value).success).toBe(false);
  });

  it("rejects marked-secret echoes, oversize data and malformed timestamps without throwing", () => {
    const value = reading();
    value.sanitized = { value: "example-token" };
    expect(
      readingSchema({ ...fullContext, secrets: ["example-token"] }).safeParse(
        value,
      ).success,
    ).toBe(false);
    value.sanitized = {};
    value.sourceUrl = "https://example.invalid/example-token";
    expect(
      readingSchema({ ...fullContext, secrets: ["example-token"] }).safeParse(
        value,
      ).success,
    ).toBe(false);
    value.sourceUrl = "https://example.invalid/";
    value.sanitized = { value: "x".repeat(1024 * 1024) };
    expect(CourtReadingSchema.safeParse(value).success).toBe(false);
    value.sanitized = {};
    value.days[0]!.intervals[0]!.start = "bad";
    expect(() => CourtReadingSchema.safeParse(value)).not.toThrow();
    expect(CourtReadingSchema.safeParse(value).success).toBe(false);
  });
});
