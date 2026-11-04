import { ConnectorError } from "../contract/errors.js";
import type {
  HttpRequest,
  TenantConfig,
  TransportProfile,
} from "../contract/types.js";

function invalid(): never {
  throw new ConnectorError("schema_changed");
}

export function snapshotRequest(
  input: HttpRequest,
  tenant: TenantConfig,
  profile: TransportProfile,
): HttpRequest {
  if (
    !input ||
    typeof input !== "object" ||
    typeof input.court !== "string" ||
    !input.court ||
    !["calendar", "identity", "bootstrap", "metadata"].includes(
      input.purpose,
    ) ||
    !["GET", "POST"].includes(input.method) ||
    !["json", "html"].includes(input.expect) ||
    !(input.url instanceof URL) ||
    (input.body !== undefined &&
      (input.method !== "POST" || typeof input.body !== "string"))
  )
    return invalid();
  const url = new URL(input.url.href);
  if (
    url.origin !== tenant.origin ||
    url.username ||
    url.password ||
    url.hash ||
    url.href.includes("#") ||
    url.href.endsWith("?")
  )
    return invalid();
  const grammar = profile.urlGrammar[input.method];
  try {
    if (!grammar || !grammar(url, tenant, input.purpose)) return invalid();
  } catch {
    return invalid();
  }

  const supplied = input.headers ?? {};
  if (typeof supplied !== "object" || Array.isArray(supplied)) return invalid();
  const seen = new Set<string>();
  const headers: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [name, value] of Object.entries(supplied)) {
    const key = name.toLowerCase();
    const rule = Object.hasOwn(profile.headers, key)
      ? profile.headers[key]
      : undefined;
    if (
      !/^[!#$%&'*+.^_`|~0-9a-z-]+$/i.test(name) ||
      seen.has(key) ||
      !rule ||
      typeof value !== "string" ||
      !value.length ||
      /[^\x20-\x7e]/.test(value) ||
      (rule.maxLength !== undefined && value.length > rule.maxLength) ||
      (rule.exact !== undefined && value !== rule.exact) ||
      rule.forbiddenPurposes?.includes(input.purpose)
    )
      return invalid();
    seen.add(key);
    headers[profile.headerNames === "lowercase" ? key : name] = value;
  }
  for (const [name, rule] of Object.entries(profile.headers)) {
    if (rule.required && !seen.has(name.toLowerCase())) return invalid();
  }
  return Object.freeze({
    court: input.court,
    purpose: input.purpose,
    method: input.method,
    url,
    headers: Object.freeze(headers),
    ...(input.body === undefined ? {} : { body: input.body }),
    expect: input.expect,
  });
}
