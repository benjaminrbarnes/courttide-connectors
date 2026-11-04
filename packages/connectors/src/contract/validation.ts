import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { CourtReadingSchema, TimeZoneSchema } from "./schemas.js";
import type { ReadShape } from "./types.js";

export interface ReadingContext {
  shape: ReadShape;
  timeZone: string;
  parkSlug?: string;
  secrets?: readonly string[];
}

export function readingSchema(context: ReadingContext) {
  return CourtReadingSchema.superRefine((reading, ctx) => {
    if (!TimeZoneSchema.safeParse(context.timeZone).success) {
      ctx.addIssue({ code: "custom", message: "Invalid IANA time zone" });
      return;
    }
    const expectedParkUrl =
      context.parkSlug === undefined
        ? undefined
        : `https://courttide.com/courts/${context.parkSlug}`;
    if (reading.attribution.parkUrl !== expectedParkUrl) {
      ctx.addIssue({
        code: "custom",
        path: ["attribution", "parkUrl"],
        message: "Attribution does not match the configured slug",
      });
    }
    const serialized = JSON.stringify(reading);
    if (
      context.secrets?.some(
        (secret) => secret.length > 0 && serialized.includes(secret),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Reading contains a marked secret",
      });
    }
    for (const [dayIndex, day] of reading.days.entries()) {
      if (context.shape === "full_calendar" && day.evidence) {
        ctx.addIssue({
          code: "custom",
          path: ["days", dayIndex, "evidence"],
          message: "A full calendar cannot have reported-range evidence",
        });
      }
      if (
        context.shape === "full_calendar" &&
        day.coverage === "partial" &&
        day.usable
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["days", dayIndex],
          message: "A partial calendar is not usable",
        });
      }
      if (
        context.shape === "continuous_ranges" &&
        day.usable &&
        (day.coverage !== "partial" || !day.evidence)
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["days", dayIndex],
          message: "Usable ranges require partial coverage and evidence",
        });
      }
      let midnight: Temporal.Instant;
      try {
        midnight = Temporal.PlainDate.from(day.date)
          .add({ days: 1 })
          .toZonedDateTime(context.timeZone)
          .toInstant();
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["days", dayIndex, "date"],
          message: "Invalid local date or time zone",
        });
        continue;
      }
      for (const [intervalIndex, interval] of day.intervals.entries()) {
        let start: Temporal.Instant;
        let end: Temporal.Instant;
        try {
          start = Temporal.Instant.from(interval.start);
          end = Temporal.Instant.from(interval.end);
        } catch {
          continue;
        }
        if (context.shape === "continuous_ranges" && !interval.available) {
          ctx.addIssue({
            code: "custom",
            path: ["days", dayIndex, "intervals", intervalIndex],
            message: "Reported ranges cannot assert unavailable time",
          });
        }
        if (
          start
            .toZonedDateTimeISO(context.timeZone)
            .toPlainDate()
            .toString() !== day.date ||
          Temporal.Instant.compare(end, midnight) > 0
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["days", dayIndex, "intervals", intervalIndex],
            message: "Interval lies outside its local day",
          });
        }
      }
    }
  });
}

export function validateCourtReading(value: unknown, context: ReadingContext) {
  return readingSchema(context).parse(value);
}

export type ValidatedCourtReading = z.output<typeof CourtReadingSchema>;
