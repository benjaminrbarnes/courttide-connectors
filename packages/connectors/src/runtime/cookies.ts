import {
  ConnectorError,
  type ConnectorRejectionReason,
} from "../contract/errors.js";
import { InstantSchema } from "../contract/schemas.js";

function fail(
  code: "schema_changed" | "access_blocked",
  reason: ConnectorRejectionReason,
): never {
  throw new ConnectorError(code, false, null, reason);
}

function pathMatches(path: string, requestPath: string): boolean {
  return (
    requestPath === path ||
    requestPath.startsWith(path.endsWith("/") ? path : `${path}/`)
  );
}

export function parseCookieJarWithExpiry(
  headers: Headers,
  url: URL,
  endpointPath: string,
  receivedAt: string,
  options: { cookieDomains: readonly string[] },
): { header: string; values: string[]; expiresAt: number | null } {
  if (!InstantSchema.safeParse(receivedAt).success)
    return fail("schema_changed", "cookie_received_at");
  const rows = headers.getSetCookie();
  if (!rows.length) return fail("schema_changed", "cookie_missing");
  if (rows.length > 16) return fail("schema_changed", "cookie_rows_limit");
  if (new TextEncoder().encode(rows.join(";")).byteLength > 16 * 1024)
    return fail("schema_changed", "cookie_bytes_limit");
  const allowed = new Set(
    options.cookieDomains.map((domain) => domain.toLowerCase()),
  );
  const jar = new Map<string, { value: string; expiresAt: number | null }>();
  for (const row of new Set(rows)) {
    const parts = row.split(";");
    const pair = parts.shift()!;
    const equal = pair.indexOf("=");
    if (equal < 1) return fail("schema_changed", "cookie_pair_invalid");
    const name = pair.slice(0, equal).trim();
    const value = pair.slice(equal + 1).trim();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name))
      return fail("schema_changed", "cookie_name_invalid");
    if (
      !/^(?:[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*|"[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*")$/.test(
        value,
      )
    )
      return fail("schema_changed", "cookie_value_invalid");
    if (jar.has(name)) return fail("schema_changed", "cookie_name_duplicate");
    let path = url.pathname.slice(0, url.pathname.lastIndexOf("/")) || "/";
    let secure = false;
    let hostOnly = true;
    let maxAge: number | null = null;
    let expires: number | null = null;
    const attributes = new Set<string>();
    for (const part of parts) {
      const at = part.indexOf("=");
      const key = (at < 0 ? part : part.slice(0, at)).trim().toLowerCase();
      const setting = at < 0 ? "" : part.slice(at + 1).trim();
      if (attributes.has(key))
        return fail("schema_changed", "cookie_attribute_duplicate");
      attributes.add(key);
      if (key === "domain") {
        if (!allowed.has(setting.replace(/^\./, "").toLowerCase()))
          return fail("access_blocked", "cookie_domain");
        hostOnly = false;
      } else if (key === "path") {
        if (!/^\/[\x21-\x7e]*$/.test(setting) || /[?#\\]/.test(setting))
          return fail("access_blocked", "cookie_path_invalid");
        path = setting;
      } else if (key === "secure") {
        if (at !== -1) return fail("schema_changed", "cookie_secure_attribute");
        secure = true;
      } else if (key === "max-age") {
        if (!/^-?\d{1,10}$/.test(setting))
          return fail("schema_changed", "cookie_max_age");
        maxAge = Number(setting);
      } else if (key === "expires") {
        expires = Date.parse(setting);
        if (!Number.isFinite(expires))
          return fail("schema_changed", "cookie_expires");
      } else if (key === "partitioned") {
        return fail("access_blocked", "cookie_partitioned");
      }
    }
    if (!pathMatches(path, endpointPath))
      return fail("access_blocked", "cookie_path_mismatch");
    if (name.startsWith("__Secure-") && !secure)
      return fail("access_blocked", "cookie_secure_prefix");
    if (name.startsWith("__Host-") && (!secure || !hostOnly || path !== "/"))
      return fail("access_blocked", "cookie_host_prefix");
    const expired =
      maxAge !== null
        ? maxAge <= 0
        : expires !== null && expires <= Date.parse(receivedAt);
    if (!expired)
      jar.set(name, {
        value,
        expiresAt:
          maxAge !== null ? Date.parse(receivedAt) + maxAge * 1000 : expires,
      });
  }
  if (!jar.size) return fail("access_blocked", "cookie_none_applicable");
  return {
    header: [...jar]
      .map(([name, cookie]) => `${name}=${cookie.value}`)
      .join("; "),
    values: [...jar.values()].map(({ value }) =>
      value.startsWith('"') ? value.slice(1, -1) : value,
    ),
    expiresAt: [...jar.values()].reduce<number | null>(
      (earliest, cookie) =>
        cookie.expiresAt === null
          ? earliest
          : earliest === null
            ? cookie.expiresAt
            : Math.min(earliest, cookie.expiresAt),
      null,
    ),
  };
}

export function parseCookieJar(
  headers: Headers,
  url: URL,
  endpointPath: string,
  receivedAt: string,
  options: { cookieDomains: readonly string[] },
): { header: string; values: string[] } {
  const { header, values } = parseCookieJarWithExpiry(
    headers,
    url,
    endpointPath,
    receivedAt,
    options,
  );
  return { header, values };
}
