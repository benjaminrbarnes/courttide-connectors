import { z } from "zod";
import { ConnectorError } from "../../contract/errors.js";
import {
  CourtSelectionSchema,
  TenantConfigSchema,
} from "../../contract/schemas.js";
import type { ConnectorContext, TenantConfig } from "../../contract/types.js";

const identifier = z.union([
  z.string().regex(/^[1-9]\d{0,31}$/),
  z.int().positive(),
]);
const occupiedMinutes = z.int().min(5).max(300).multipleOf(5);
export const civicRecTenantParams = z.object({
  catalogPath: z
    .string()
    .regex(/^\/[A-Z]{2}\/[a-z0-9]+(?:-[a-z0-9]+)*\/catalog$/),
  locationId: identifier,
});
export const civicRecCourtParams = z
  .object({
    facilityId: identifier,
    rateTypeId: identifier,
    groupId: identifier,
    detailsTextSha256: z.string().regex(/^[a-f0-9]{64}$/),
    startIncrementMinutes: z.union([z.literal(5), z.literal(15)]),
    minimumOccupiedMinutes: occupiedMinutes,
    maximumOccupiedMinutes: occupiedMinutes,
    durationStepMinutes: occupiedMinutes,
    closesLocal: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    filterKeyVersion: z.string().min(1),
  })
  .refine(
    (value) => value.maximumOccupiedMinutes >= value.minimumOccupiedMinutes,
  );

export type CivicRecCourtParams = z.output<typeof civicRecCourtParams>;
export interface SelectedCourt {
  key: string;
  params: CivicRecCourtParams;
  parkSlug?: string;
}
export interface CivicRecConfig {
  tenant: string;
  timeZone: string;
  catalogUrl: URL;
  courts: Map<string, SelectedCourt>;
}

export function configure(context: ConnectorContext): CivicRecConfig {
  if (
    !context ||
    !TenantConfigSchema.safeParse(context.tenant).success ||
    context.tenant.platform !== "civicrec" ||
    context.tenant.origin !== "https://secure.rec1.com" ||
    context.tenant.timeZone.length > 100 ||
    typeof context.http?.request !== "function" ||
    typeof context.now !== "function"
  )
    throw new ConnectorError("schema_changed");
  const tenant = context.tenant as TenantConfig;
  const parsed = civicRecTenantParams.safeParse(tenant.params);
  if (!parsed.success) throw new ConnectorError("schema_changed");
  const catalogUrl = new URL(parsed.data.catalogPath, tenant.origin);
  if (
    catalogUrl.href.length > 256 ||
    catalogUrl.pathname !== parsed.data.catalogPath
  )
    throw new ConnectorError("schema_changed");
  const all = new Map<string, SelectedCourt>();
  for (const park of tenant.parks) {
    for (const court of park.courts) {
      const params = civicRecCourtParams.safeParse(court.params);
      if (!params.success || all.has(court.key))
        throw new ConnectorError("schema_changed");
      all.set(court.key, {
        key: court.key,
        params: params.data,
        ...(park.courttideSlug ? { parkSlug: park.courttideSlug } : {}),
      });
    }
  }
  const keys = [...all.keys()];
  if (!CourtSelectionSchema.safeParse(keys).success)
    throw new ConnectorError("schema_changed");
  const selected = context.courts ?? keys;
  if (
    !CourtSelectionSchema.safeParse(selected).success ||
    selected.some((key) => !all.has(key))
  )
    throw new ConnectorError("identity_mismatch");
  const courts = new Map(selected.map((key) => [key, all.get(key)!]));
  return {
    tenant: tenant.tenant,
    timeZone: tenant.timeZone,
    catalogUrl,
    courts,
  };
}
