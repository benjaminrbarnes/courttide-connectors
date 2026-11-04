import { Temporal } from "@js-temporal/polyfill";
import { z } from "zod";
import { ATTRIBUTION } from "./constants.js";
import type { ConnectorError } from "./errors.js";

export const LocalDateSchema = z.iso.date();
export const InstantSchema = z.iso.datetime();
export const PlatformIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
export const CourtKeySchema = z.string().min(1);

export const TimeZoneSchema = z
  .string()
  .regex(/^(?:UTC|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Expected an IANA time zone");

const OriginSchema = z
  .url()
  .regex(/^https?:\/\/[^/@?#]+$/)
  .refine((value) => {
    const url = new URL(value);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.origin === value
    );
  }, "Expected an origin without a path, credentials, query or fragment");

const CourtConfigSchema = z.looseObject({
  key: CourtKeySchema,
  label: z.string().min(1),
  platformLabel: z.string().min(1).optional(),
  retired: LocalDateSchema.optional(),
  params: z.unknown(),
});
const ParkConfigSchema = z.looseObject({
  key: z.string().min(1),
  name: z.string().min(1),
  courttideSlug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    .optional(),
  publicTimes: z.boolean().optional(),
  courts: z.array(CourtConfigSchema),
});
export const TenantConfigSchema = z.looseObject({
  $schema: z.string().optional(),
  schemaVersion: z.literal("1"),
  platform: PlatformIdSchema,
  tenant: z.string().min(1),
  timeZone: TimeZoneSchema,
  origin: OriginSchema,
  params: z.unknown(),
  parks: z.array(ParkConfigSchema),
});

export const ParserIdentitySchema = z.strictObject({
  id: z.string().min(1),
  version: z.string().min(1),
  signature: z.string().min(1),
});
export const CapabilitiesSchema = z.strictObject({
  auth: z.literal("none"),
  shape: z.enum(["full_calendar", "continuous_ranges"]),
  maxDaysPerRead: z.int().positive(),
  leaseScope: z.enum(["per_read", "per_request"]),
  requests: z.strictObject({
    perRead: z.int().nonnegative(),
    perSessionBootstrap: z.int().nonnegative(),
  }),
  minimumGapMs: z.int().min(10000),
  identity: z.enum(["label_check", "none"]),
  bookingWrites: z.literal(false),
});
export const EvidenceSchema = z
  .strictObject({
    kind: z.literal("continuous_ranges"),
    scope: z.literal("reported_ranges_only"),
    startIncrementMinutes: z.union([z.literal(5), z.literal(15)]),
    startAnchor: z.enum(["local_midnight", "range_start"]),
    minimumOccupiedMinutes: z.int().positive(),
    durationStepMinutes: z.int().positive(),
    maximumOccupiedMinutes: z.int().positive().optional(),
  })
  .superRefine((value, ctx) => {
    if (
      value.maximumOccupiedMinutes !== undefined &&
      value.maximumOccupiedMinutes < value.minimumOccupiedMinutes
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Maximum occupied duration is below the minimum",
      });
    }
  });
export const IntervalSchema = z.strictObject({
  start: InstantSchema,
  end: InstantSchema,
  available: z.boolean(),
});
export const DayReadingSchema = z
  .strictObject({
    date: LocalDateSchema,
    observedAt: InstantSchema.optional(),
    status: z.int(),
    visibility: z.enum(["visible", "hidden_or_unavailable", "unknown"]),
    coverage: z.enum(["complete", "partial", "invalid"]),
    usable: z.boolean(),
    reasonCodes: z.array(z.string().min(1)),
    intervals: z.array(IntervalSchema),
    evidence: EvidenceSchema.optional(),
  })
  .superRefine((day, ctx) => {
    if (
      day.usable &&
      (day.visibility !== "visible" || day.coverage === "invalid")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "A hidden, unknown or invalid day cannot be usable",
      });
    }
    if (day.usable && day.coverage === "partial" && !day.evidence) {
      ctx.addIssue({
        code: "custom",
        message: "Usable partial coverage requires reported-only evidence",
      });
    }
    if (
      (day.coverage === "invalid" || day.visibility !== "visible") &&
      day.intervals.length > 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["intervals"],
        message: "Invalid, hidden or unknown days cannot have intervals",
      });
    }
    const parsed: {
      start: Temporal.Instant;
      end: Temporal.Instant;
      index: number;
    }[] = [];
    for (const [index, interval] of day.intervals.entries()) {
      const completeUsableCalendar =
        day.usable &&
        day.visibility === "visible" &&
        day.coverage === "complete" &&
        !day.evidence;
      const retainedPartialEvidence =
        !day.usable &&
        day.visibility === "visible" &&
        day.coverage === "partial" &&
        !day.evidence;
      if (
        !interval.available &&
        !completeUsableCalendar &&
        !retainedPartialEvidence
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["intervals", index],
          message:
            "Unavailable flags require a complete calendar or retained partial source evidence",
        });
      }
      let start: Temporal.Instant;
      let end: Temporal.Instant;
      try {
        start = Temporal.Instant.from(interval.start);
        end = Temporal.Instant.from(interval.end);
      } catch {
        continue;
      }
      if (Temporal.Instant.compare(start, end) >= 0) {
        ctx.addIssue({
          code: "custom",
          path: ["intervals", index],
          message: "Intervals must be positive",
        });
      }
      parsed.push({ start, end, index });
    }
    const reportedRanges =
      day.coverage === "partial" &&
      day.evidence?.kind === "continuous_ranges" &&
      day.intervals.every((interval) => interval.available);
    if (!reportedRanges) {
      parsed.sort((left, right) =>
        Temporal.Instant.compare(left.start, right.start),
      );
      for (let index = 1; index < parsed.length; index += 1) {
        if (
          Temporal.Instant.compare(
            parsed[index]!.start,
            parsed[index - 1]!.end,
          ) < 0
        ) {
          ctx.addIssue({
            code: "custom",
            path: ["intervals", parsed[index]!.index],
            message: "Intervals must not overlap",
          });
        }
      }
    }
  });

export const CourtReadingSchema = z
  .strictObject({
    platform: PlatformIdSchema,
    tenant: z.string().min(1),
    court: CourtKeySchema,
    startDate: LocalDateSchema,
    endDate: LocalDateSchema,
    complete: z.boolean(),
    observedAt: InstantSchema,
    sourceUrl: z.url(),
    days: z.array(DayReadingSchema),
    sanitized: z.json(),
    parser: ParserIdentitySchema,
    attribution: z.strictObject({
      text: z.literal(ATTRIBUTION.text),
      url: z.literal(ATTRIBUTION.url),
      parkUrl: z.url().optional(),
    }),
  })
  .superRefine((reading, ctx) => {
    if (
      LocalDateSchema.safeParse(reading.startDate).success &&
      LocalDateSchema.safeParse(reading.endDate).success &&
      Temporal.PlainDate.compare(reading.startDate, reading.endDate) > 0
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "End date precedes start date",
      });
    }
    if (
      new TextEncoder().encode(JSON.stringify(reading.sanitized)).byteLength >
      1024 * 1024
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sanitized"],
        message: "Sanitized output exceeds 1 MiB",
      });
    }
  });

const CallbackSchema = z.custom<(...args: never[]) => unknown>(
  (value) => typeof value === "function",
);
export const CourtSelectionSchema = z
  .array(CourtKeySchema)
  .min(1)
  .max(256)
  .refine(
    (values) => new Set(values).size === values.length,
    "Selected court keys must be unique",
  );
export const ConnectorContextSchema = z.object({
  tenant: TenantConfigSchema,
  courts: CourtSelectionSchema.optional(),
  http: z.object({ request: CallbackSchema }),
  now: CallbackSchema,
  signal: z.instanceof(AbortSignal).optional(),
});
export const GateRequestSchema = z.strictObject({
  court: CourtKeySchema,
  purpose: z.enum(["calendar", "identity", "bootstrap", "metadata"]),
  method: z.enum(["GET", "POST"]),
  url: z.url(),
});
export const GateOutcomeSchema = z
  .strictObject({
    ok: z.boolean(),
    status: z.int().optional(),
    error: z
      .enum([
        "auth_required",
        "http_error",
        "rate_limited",
        "access_blocked",
        "schema_changed",
        "identity_mismatch",
        "date_coverage_incomplete",
        "invalid_interval",
        "unsupported_time",
      ])
      .optional(),
    retryAfterMs: z.number().nonnegative().nullable().optional(),
    retryable: z.boolean().optional(),
  })
  .superRefine((outcome, ctx) => {
    if (!outcome.ok && !outcome.error)
      ctx.addIssue({
        code: "custom",
        message: "Failed outcomes require an error code",
      });
    if (outcome.ok && outcome.retryable !== undefined)
      ctx.addIssue({
        code: "custom",
        message: "Retryability applies only to failed outcomes",
      });
  });
export const TransportProfileSchema = z.strictObject({
  retryAfter: z.enum(["strict-imf", "lenient"]),
  successStatuses: z.enum(["any-2xx", "200-only"]),
  classificationOrder: z.enum(["headers-first", "legacy-body-first"]),
  headerNames: z.enum(["preserve", "lowercase"]),
  fetchInput: z.enum(["url", "string"]),
  abortRetryable: z.enum(["timeout-only", "any-abort"]),
  timeoutSignal: z.enum(["controller", "native"]).optional(),
  timeoutReason: z.enum(["timeout-error", "abort-error"]).optional(),
  abortFailure: z.enum(["reason", "retryable-http"]).optional(),
  cleanupAbort: z.enum(["before-body", "after-body", "none"]).optional(),
  transportErrors: z.enum(["preserve", "http-only"]).optional(),
  classifyTransportError: z
    .custom<(error: unknown) => ConnectorError | undefined>(
      (value) => typeof value === "function",
    )
    .optional(),
  redirectHeaders: z.array(z.string()),
  contentLengthChecks: z.boolean(),
  jsonContentTypes: z.array(z.string()),
  htmlContentTypes: z.array(z.string()),
  classifyJsonForHtml: z.boolean().optional(),
  challenge: z
    .object({
      passiveAssets: z.array(z.string()),
      scope: z.enum(["html-or-leading", "all"]),
    })
    .nullable(),
  headers: z.record(
    z.string(),
    z.object({
      required: z.boolean().optional(),
      exact: z.string().optional(),
      maxLength: z.int().positive().optional(),
      forbiddenPurposes: z
        .array(z.enum(["calendar", "identity", "bootstrap", "metadata"]))
        .optional(),
    }),
  ),
  urlGrammar: z.object({
    GET: CallbackSchema.optional(),
    POST: CallbackSchema.optional(),
  }),
  cookieJar: z
    .object({
      cookieDomains: z.array(z.string()),
      maxCookies: z.literal(16),
      maxBytes: z.literal(16384),
      rejectPartitioned: z.literal(true),
      enforceSecurePrefixes: z.literal(true),
      pathFor: CallbackSchema,
    })
    .nullable(),
  classify: CallbackSchema.optional(),
});
