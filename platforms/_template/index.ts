import { z } from "zod";
import {
  ATTRIBUTION,
  ConnectorError,
  CourtSelectionSchema,
  TenantConfigSchema,
  defaultTransportProfile,
} from "../../packages/connectors/src/index.js";
import type {
  ConnectorContext,
  Platform,
} from "../../packages/connectors/src/index.js";

const parser = { id: "example-parser", version: "1", signature: "example-v1" };
const params = z.object({});
const capabilities = {
  auth: "none",
  shape: "full_calendar",
  maxDaysPerRead: 1,
  leaseScope: "per_request",
  requests: { perRead: 1, perSessionBootstrap: 0 },
  minimumGapMs: 2500,
  identity: "none",
  bookingWrites: false,
} as const;

export function parseExample(value: unknown) {
  const shape = z.strictObject({
    date: z.iso.date(),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
  });
  const parsed = shape.safeParse(value);
  if (!parsed.success) throw new ConnectorError("schema_changed");
  if (Date.parse(parsed.data.start) >= Date.parse(parsed.data.end))
    throw new ConnectorError("invalid_interval");
  return parsed.data;
}

export function buildExampleUrl(
  origin: string,
  court: string,
  date: string,
): URL {
  const url = new URL(`/calendar/${encodeURIComponent(court)}`, origin);
  url.searchParams.set("date", date);
  return url;
}

export const examplePlatform: Platform = {
  id: "example",
  parser,
  tenantParams: params,
  courtParams: params,
  transport: defaultTransportProfile({
    headers: { accept: { required: true, exact: "application/json" } },
    urlGrammar: {
      GET: (url, tenant, purpose) =>
        purpose === "calendar" &&
        tenant.origin === "https://example.invalid" &&
        url.pathname === "/calendar/900001" &&
        [...url.searchParams.keys()].join(",") === "date" &&
        z.iso.date().safeParse(url.searchParams.get("date")).success,
    },
  }),
  capabilities: () => ({
    ...capabilities,
    requests: { ...capabilities.requests },
  }),
  createConnector(context: ConnectorContext) {
    const config = TenantConfigSchema.safeParse(context.tenant);
    if (
      !config.success ||
      config.data.platform !== "example" ||
      config.data.origin !== "https://example.invalid"
    )
      throw new ConnectorError("schema_changed");
    const configured = config.data.parks.flatMap((park) =>
      park.courts.map((court) => court.key),
    );
    const selected = context.courts ?? configured;
    if (
      !CourtSelectionSchema.safeParse(configured).success ||
      !CourtSelectionSchema.safeParse(selected).success ||
      selected.some((key) => !configured.includes(key))
    )
      throw new ConnectorError("identity_mismatch");
    const allowed = new Set(selected);
    const tenant = config.data.tenant;
    const origin = config.data.origin;
    const park = config.data.parks.find((item) =>
      item.courts.some((court) => court.key === "900001"),
    );
    return {
      capabilities: { ...capabilities, requests: { ...capabilities.requests } },
      async readCourt(court, range) {
        if (!allowed.has(court)) throw new ConnectorError("identity_mismatch");
        if (
          !range ||
          range.start !== range.end ||
          !z.iso.date().safeParse(range.start).success
        )
          throw new ConnectorError("unsupported_time");
        const date = range.start;
        const url = buildExampleUrl(origin, court, date);
        const response = await context.http.request({
          court,
          purpose: "calendar",
          method: "GET",
          url,
          headers: { accept: "application/json" },
          expect: "json",
        });
        let payload: unknown;
        try {
          payload = JSON.parse(response.text);
        } catch {
          throw new ConnectorError("schema_changed");
        }
        const result = parseExample(payload);
        if (result.date !== date) throw new ConnectorError("schema_changed");
        return {
          platform: "example",
          tenant,
          court,
          startDate: date,
          endDate: date,
          complete: true,
          observedAt: context.now().toISOString(),
          sourceUrl: url.href,
          days: [
            {
              date,
              observedAt: response.receivedAt,
              status: 0,
              visibility: "visible",
              coverage: "complete",
              usable: true,
              reasonCodes: [],
              intervals: [
                { start: result.start, end: result.end, available: true },
              ],
            },
          ],
          sanitized: result,
          parser,
          attribution: {
            ...ATTRIBUTION,
            ...(park?.courttideSlug
              ? {
                  parkUrl: `https://courttide.com/courts/${park.courttideSlug}`,
                }
              : {}),
          },
        };
      },
    };
  },
};
