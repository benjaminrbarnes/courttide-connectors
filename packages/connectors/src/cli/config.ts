import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { CapabilitiesSchema, TenantConfigSchema } from "../contract/schemas.js";
import type { Platform, TenantConfig } from "../contract/types.js";

export function loadConfig(path: string, cwd: string): TenantConfig {
  try {
    return TenantConfigSchema.parse(
      JSON.parse(readFileSync(resolve(cwd, path), "utf8")),
    ) as TenantConfig;
  } catch {
    throw new Error("Tenant config is missing or invalid");
  }
}

export function validatePlatformConfig(
  tenant: TenantConfig,
  platform: Platform,
): ReturnType<Platform["capabilities"]> {
  if (tenant.platform !== platform.id) throw new Error("Platform mismatch");
  if (!platform.tenantParams.safeParse(tenant.params).success)
    throw new Error("Tenant parameters are invalid for this platform");
  for (const park of tenant.parks) {
    for (const court of park.courts) {
      if (!platform.courtParams.safeParse(court.params).success)
        throw new Error("Court parameters are invalid for this platform");
    }
  }
  try {
    return CapabilitiesSchema.parse(platform.capabilities(tenant));
  } catch {
    throw new Error("Platform capabilities are invalid");
  }
}

export function configFiles(path: string, cwd: string): string[] {
  const absolute = resolve(cwd, path);
  // Config discovery is deliberately non-recursive; users select nested directories explicitly.
  if (statSync(absolute).isFile()) return [absolute];
  return readdirSync(absolute)
    .filter((name) => name.endsWith(".json"))
    .map((name) => resolve(absolute, name))
    .sort();
}
