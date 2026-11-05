import { z } from "zod";
import {
  ATTRIBUTION,
  DEFAULT_DEVELOPMENT_GAP_MS,
} from "../../contract/constants.js";
import { ConnectorError } from "../../contract/errors.js";
import type {
  Capabilities,
  Connector,
  ConnectorContext,
  Platform,
  TenantConfig,
} from "../../contract/types.js";
import { activeNetLegacyProfile } from "../../runtime/profiles.js";
import {
  buildReading,
  calendarUrl,
  parseDateRange,
  parseIdentity,
  parser,
  validCourtKey,
} from "./parser.js";

const tenantParamsSchema = z.strictObject({
  basePath: z.string().regex(/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/),
});
const courtParamsSchema = z.strictObject({});

type TenantParams = z.infer<typeof tenantParamsSchema>;
type CourtParams = z.infer<typeof courtParamsSchema>;

function fail(code: ConstructorParameters<typeof ConnectorError>[0]): never {
  throw new ConnectorError(code);
}

const capabilities: Capabilities = {
  auth: "none",
  shape: "full_calendar",
  maxDaysPerRead: 7,
  leaseScope: "per_read",
  requests: { perRead: 1, perSessionBootstrap: 0 },
  minimumGapMs: DEFAULT_DEVELOPMENT_GAP_MS,
  identity: "label_check",
  bookingWrites: false,
};

export const activeNetPlatform: Platform<TenantParams, CourtParams> = {
  id: "activenet",
  parser,
  tenantParams: tenantParamsSchema,
  courtParams: courtParamsSchema,
  transport: activeNetLegacyProfile,
  capabilities: () => ({
    ...capabilities,
    requests: { ...capabilities.requests },
  }),
  createConnector(
    context: ConnectorContext<TenantParams, CourtParams>,
  ): Connector {
    if (
      context.tenant.platform !== "activenet" ||
      typeof context.http?.request !== "function" ||
      typeof context.now !== "function"
    )
      fail("schema_changed");
    const tenantResult = tenantParamsSchema.safeParse(context.tenant.params);
    if (!tenantResult.success) fail("schema_changed");
    const tenant = context.tenant as TenantConfig<TenantParams, CourtParams>;
    const seen = new Set<string>();
    for (const park of tenant.parks) {
      for (const item of park.courts) {
        if (
          !validCourtKey(item.key) ||
          !courtParamsSchema.safeParse(item.params).success
        )
          fail("identity_mismatch");
        if (seen.has(item.key)) fail("identity_mismatch");
        seen.add(item.key);
      }
    }
    const configured = [...seen];
    if (!configured.length || configured.length > 256)
      fail("identity_mismatch");
    const allowed = context.courts ?? configured;
    if (
      !Array.isArray(allowed) ||
      allowed.length < 1 ||
      allowed.length > 256 ||
      new Set(allowed).size !== allowed.length ||
      allowed.some((key) => !validCourtKey(key) || !seen.has(key))
    )
      fail("identity_mismatch");
    const allowedSet = new Set(allowed);
    const basePath = tenantResult.data.basePath;

    return {
      capabilities: activeNetPlatform.capabilities(tenant),
      async readCourt(court, range) {
        if (!validCourtKey(court) || !allowedSet.has(court))
          fail("identity_mismatch");
        const dates = parseDateRange(range.start, range.end);
        const url = new URL(
          calendarUrl(tenant.origin, basePath, court, dates[0]!, dates.at(-1)!),
        );
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
          fail("schema_changed");
        }
        const parsed = buildReading(
          payload,
          court,
          dates[0]!,
          dates.at(-1)!,
          tenant.timeZone,
          tenant.origin,
          basePath,
        );
        const observedAt = context.now();
        if (
          !(observedAt instanceof Date) ||
          !Number.isFinite(observedAt.getTime())
        )
          fail("schema_changed");
        const park = tenant.parks.find((candidate) =>
          candidate.courts.some((item) => item.key === court),
        );
        return {
          platform: "activenet",
          tenant: tenant.tenant,
          court,
          ...parsed,
          observedAt: observedAt.toISOString(),
          parser,
          attribution: {
            text: ATTRIBUTION.text,
            url: ATTRIBUTION.url,
            ...(park?.courttideSlug
              ? {
                  parkUrl: `https://courttide.com/courts/${park.courttideSlug}`,
                }
              : {}),
          },
        };
      },
      async verifyCourt(court) {
        if (!validCourtKey(court) || !allowedSet.has(court))
          fail("identity_mismatch");
        const url = new URL(
          `${tenant.origin}${basePath}/rest/reservation/resource/detail/${court}`,
        );
        const response = await context.http.request({
          court,
          purpose: "identity",
          method: "GET",
          url,
          headers: { accept: "application/json" },
          expect: "json",
        });
        let payload: unknown;
        try {
          payload = JSON.parse(response.text);
        } catch {
          fail("schema_changed");
        }
        const identity = parseIdentity(payload, court);
        return { court, platformLabel: identity.platformLabel };
      },
    };
  },
};
