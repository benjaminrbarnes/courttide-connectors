import { Temporal } from "@js-temporal/polyfill";
import {
  ATTRIBUTION,
  DEFAULT_DEVELOPMENT_GAP_MS,
} from "../../contract/constants.js";
import { ConnectorError } from "../../contract/errors.js";
import type {
  Capabilities,
  Connector,
  ConnectorContext,
  CourtReading,
  DayReading,
  Evidence,
  Platform,
} from "../../contract/types.js";
import { civicRecLegacyProfile } from "../../runtime/profiles.js";
import { CivicRecReader } from "./client.js";
import {
  civicRecCourtParams,
  civicRecTenantParams,
  configure,
} from "./config.js";
import type { SelectedCourt } from "./config.js";

const parser = {
  id: "civicrec-anonymous",
  version: "civicrec-hours-1",
  signature: "civicrec-hours-v1",
} as const;
const capabilities: Capabilities = {
  auth: "none",
  shape: "continuous_ranges",
  maxDaysPerRead: 2,
  leaseScope: "per_request",
  requests: { perRead: 2, perSessionBootstrap: 1 },
  minimumGapMs: DEFAULT_DEVELOPMENT_GAP_MS,
  identity: "none",
  bookingWrites: false,
};
function dates(start: string, end: string): string[] {
  try {
    if (
      typeof start !== "string" ||
      typeof end !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(start) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(end)
    )
      throw Error();
    const first = Temporal.PlainDate.from(start, { overflow: "reject" });
    const last = Temporal.PlainDate.from(end, { overflow: "reject" });
    const span = last.since(first).days;
    if (
      first.toString() !== start ||
      last.toString() !== end ||
      span < 0 ||
      span > 1
    )
      throw Error();
    return span === 0 ? [start] : [start, end];
  } catch {
    throw new ConnectorError("unsupported_time");
  }
}
function reportedEvidence(court: SelectedCourt): Evidence {
  const p = court.params;
  return {
    kind: "continuous_ranges",
    scope: "reported_ranges_only",
    startIncrementMinutes: p.startIncrementMinutes,
    startAnchor: "range_start",
    minimumOccupiedMinutes: p.minimumOccupiedMinutes,
    durationStepMinutes: p.durationStepMinutes,
    maximumOccupiedMinutes: p.maximumOccupiedMinutes,
  };
}
function sanitizedEvidence(e: Evidence) {
  return {
    kind: e.kind,
    scope: e.scope,
    start_increment_minutes: e.startIncrementMinutes,
    start_anchor: e.startAnchor,
    minimum_occupied_minutes: e.minimumOccupiedMinutes,
    duration_step_minutes: e.durationStepMinutes,
    ...(e.maximumOccupiedMinutes === undefined
      ? {}
      : { maximum_occupied_minutes: e.maximumOccupiedMinutes }),
  };
}

export function createCivicRecConnector(context: ConnectorContext): Connector {
  const config = configure(context);
  const request = context.http.request.bind(context.http);
  const now = context.now;
  const reader = new CivicRecReader(
    config,
    { request },
    {
      http: context.http,
      tenant: context.tenant,
      signal: context.signal,
    },
  );
  return {
    capabilities,
    async readCourt(key, range): Promise<CourtReading> {
      const court = config.courts.get(key);
      if (!court) throw new ConnectorError("identity_mismatch");
      const startDate = range?.start;
      const endDate = range?.end;
      const requested = dates(startDate, endDate);
      const days: DayReading[] = [];
      let complete = true;
      for (const date of requested) {
        const { evidence: result, receivedAt } = await reader.readHours(
          court,
          date,
        );
        if (
          result.context?.facilityId !== String(court.params.facilityId) ||
          result.context.rateTypeId !== String(court.params.rateTypeId) ||
          result.context.date !== date ||
          result.context.timeZone !== config.timeZone
        )
          throw new ConnectorError("identity_mismatch");
        const empty =
          result.kind === "partial" &&
          !result.hours.length &&
          !result.displayHours.length &&
          result.issues.every((issue) =>
            ["empty_hours", "empty_display_hours"].includes(issue),
          );
        complete &&= result.kind === "parsed" || empty;
        const hidden = result.availableForRate === false;
        const eligible =
          !hidden &&
          result.kind === "parsed" &&
          result.displayAgreement === "matching" &&
          result.availableForRate === true;
        let close: Temporal.Instant;
        try {
          close = Temporal.PlainDate.from(date)
            .toPlainDateTime(court.params.closesLocal)
            .toZonedDateTime(config.timeZone, { disambiguation: "reject" })
            .toInstant();
        } catch {
          throw new ConnectorError("unsupported_time");
        }
        const intervals: DayReading["intervals"] = [];
        if (eligible)
          for (const item of result.hours) {
            if (item.block) continue;
            const start = Temporal.Instant.from(item.start);
            const sourceEnd = Temporal.Instant.from(item.end);
            const end =
              Temporal.Instant.compare(sourceEnd, close) > 0
                ? close
                : sourceEnd;
            if (Temporal.Instant.compare(start, end) < 0)
              intervals.push({
                start: start.toString(),
                end: end.toString(),
                available: true,
              });
          }
        const usable = intervals.length > 0;
        days.push({
          date,
          observedAt: receivedAt,
          status: 200,
          visibility: hidden
            ? "hidden_or_unavailable"
            : usable
              ? "visible"
              : "unknown",
          coverage: "partial",
          usable,
          reasonCodes: [
            "reported_ranges_only",
            ...result.issues,
            ...(hidden ? ["source_hidden_or_unavailable"] : []),
            ...(!usable ? ["occupancy_unknown"] : []),
          ],
          intervals,
          evidence: reportedEvidence(court),
        });
      }
      let observedAt: string;
      try {
        observedAt = now().toISOString();
      } catch {
        throw new ConnectorError("schema_changed");
      }
      return {
        platform: "civicrec",
        tenant: config.tenant,
        court: key,
        startDate,
        endDate,
        complete,
        observedAt,
        sourceUrl: config.catalogUrl.href,
        days,
        sanitized: {
          resource_id: String(court.params.facilityId),
          days: days.map((day) => ({
            date: day.date,
            visibility: day.visibility,
            coverage: day.coverage,
            usable: day.usable,
            reason_codes: [...day.reasonCodes],
            intervals: day.intervals.map((interval) => ({ ...interval })),
            availability_evidence: sanitizedEvidence(day.evidence!),
          })),
        },
        parser,
        attribution: {
          ...ATTRIBUTION,
          ...(court.parkSlug
            ? { parkUrl: `https://courttide.com/courts/${court.parkSlug}` }
            : {}),
        },
      };
    },
  };
}
export const civicRecPlatform: Platform = {
  id: "civicrec",
  parser,
  tenantParams: civicRecTenantParams,
  courtParams: civicRecCourtParams,
  transport: civicRecLegacyProfile,
  capabilities: () => capabilities,
  createConnector: createCivicRecConnector,
};
