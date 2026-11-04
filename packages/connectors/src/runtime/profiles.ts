import { ConnectorError } from "../contract/errors.js";
import type {
  HeaderRule,
  RequestMethod,
  RequestPurpose,
  TenantConfig,
  TransportProfile,
} from "../contract/types.js";
import { parseLocalDate } from "./temporal.js";

function params(tenant: TenantConfig): Record<string, unknown> | null {
  return tenant.params &&
    typeof tenant.params === "object" &&
    !Array.isArray(tenant.params)
    ? (tenant.params as Record<string, unknown>)
    : null;
}

function date(value: string): boolean {
  try {
    parseLocalDate(value);
    return true;
  } catch {
    return false;
  }
}

function activeRange(start: string, end: string): boolean {
  try {
    const days =
      parseLocalDate(end).since(parseLocalDate(start), { largestUnit: "days" })
        .days + 1;
    return days >= 1 && days <= 7;
  } catch {
    return false;
  }
}

function activeNetUrl(
  url: URL,
  tenant: TenantConfig,
  purpose: RequestPurpose,
): boolean {
  if (
    url.protocol !== "https:" ||
    !(
      url.hostname === "activecommunities.com" ||
      url.hostname.endsWith(".activecommunities.com")
    )
  )
    return false;
  const base = params(tenant)?.basePath;
  if (typeof base !== "string" || !/^\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(base))
    return false;
  const prefix = `${base}/rest/reservation/resource/`;
  if (!url.pathname.startsWith(prefix)) return false;
  const tail = url.pathname.slice(prefix.length);
  if (purpose === "identity")
    return /^detail\/[1-9]\d{0,9}$/.test(tail) && !url.search;
  if (
    purpose !== "calendar" ||
    !/^availability\/daily\/[1-9]\d{0,9}$/.test(tail)
  )
    return false;
  const query = [...url.searchParams.entries()];
  return (
    query.length === 5 &&
    query[0]?.[0] === "start_date" &&
    date(query[0][1]) &&
    query[1]?.[0] === "end_date" &&
    date(query[1][1]) &&
    activeRange(query[0][1], query[1][1]) &&
    query[2]?.[0] === "customer_id" &&
    query[2][1] === "0" &&
    query[3]?.[0] === "company_id" &&
    query[3][1] === "0" &&
    query[4]?.[0] === "locale" &&
    query[4][1] === "en-US"
  );
}

function identifier(value: string): boolean {
  return /^[1-9]\d{0,31}$/.test(value);
}
function contextKey(value: string): boolean {
  try {
    const decoded = decodeURIComponent(value);
    return (
      /^[\x21-\x7e]{1,1024}$/.test(decoded) &&
      decoded !== "." &&
      decoded !== ".." &&
      encodeURIComponent(decoded) === value
    );
  } catch {
    return false;
  }
}

function civicRecUrl(
  url: URL,
  tenant: TenantConfig,
  purpose: RequestPurpose,
): boolean {
  if (url.origin !== "https://secure.rec1.com" || url.href.length > 4096)
    return false;
  const profile = params(tenant);
  const catalog = profile?.catalogPath;
  if (
    typeof catalog !== "string" ||
    !/^\/[A-Z]{2}\/[a-z0-9]+(?:-[a-z0-9]+)*\/catalog$/.test(catalog) ||
    `${url.origin}${catalog}`.length > 256 ||
    url.search ||
    url.hash
  )
    return false;
  if (url.pathname === catalog) return purpose === "bootstrap";
  if (!url.pathname.startsWith(`${catalog}/`)) return false;
  const parts = url.pathname.slice(catalog.length + 1).split("/");
  const [method, key, facility, extra, targetDate] = parts;
  if (!key || !contextKey(key)) return false;
  if (purpose === "calendar") {
    return (
      method === "getFacilityHours" &&
      parts.length === 5 &&
      identifier(facility!) &&
      identifier(extra!) &&
      date(targetDate!)
    );
  }
  if (purpose !== "metadata" && purpose !== "identity") return false;
  if (method === "getLocationFacilities") {
    const location = profile?.locationId;
    return (
      parts.length === 4 &&
      (typeof location === "string" || typeof location === "number") &&
      identifier(String(location)) &&
      facility === String(location) &&
      identifier(extra!)
    );
  }
  if (method === "facilityDetails")
    return parts.length === 3 && identifier(facility!);
  return (
    method === "getFacilityRates" &&
    parts.length === 4 &&
    identifier(facility!) &&
    date(extra!)
  );
}

export const activeNetLegacyProfile: TransportProfile = {
  retryAfter: "strict-imf",
  successStatuses: "any-2xx",
  classificationOrder: "headers-first",
  headerNames: "lowercase",
  fetchInput: "url",
  abortRetryable: "timeout-only",
  redirectHeaders: [],
  contentLengthChecks: false,
  jsonContentTypes: ["application/json"],
  htmlContentTypes: [],
  challenge: null,
  headers: { accept: { required: true, exact: "application/json" } },
  urlGrammar: { GET: activeNetUrl },
  cookieJar: null,
};

export const civicRecLegacyProfile: TransportProfile = {
  retryAfter: "lenient",
  successStatuses: "200-only",
  classificationOrder: "legacy-body-first",
  headerNames: "lowercase",
  fetchInput: "string",
  abortRetryable: "any-abort",
  redirectHeaders: ["location", "refresh"],
  contentLengthChecks: true,
  jsonContentTypes: ["application/json", "text/json"],
  htmlContentTypes: ["text/html"],
  classifyJsonForHtml: true,
  challenge: {
    passiveAssets: ["/cdn-cgi/challenge-platform/scripts/jsd/main.js"],
    scope: "all",
  },
  headers: {
    accept: { required: true, maxLength: 256 },
    cookie: { maxLength: 16 * 1024, forbiddenPurposes: ["bootstrap"] },
    "x-requested-with": {
      exact: "XMLHttpRequest",
      maxLength: 256,
      forbiddenPurposes: ["bootstrap"],
    },
  },
  urlGrammar: { GET: civicRecUrl },
  cookieJar: {
    cookieDomains: ["secure.rec1.com", "rec1.com"],
    maxCookies: 16,
    maxBytes: 16384,
    rejectPartitioned: true,
    enforceSecurePrefixes: true,
    pathFor(request) {
      return request.url.pathname.replace(
        /catalog(?:\/.*)?$/,
        "catalog/getFacilityHours/",
      );
    },
  },
  classify(body) {
    if (
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      "error" in body &&
      typeof body.error === "string" &&
      /expired|denied|unauthorized|forbidden|login required/i.test(body.error)
    )
      throw new ConnectorError("access_blocked");
  },
};

export function defaultTransportProfile(options: {
  urlGrammar: Partial<
    Record<
      RequestMethod,
      (url: URL, tenant: TenantConfig, purpose: RequestPurpose) => boolean
    >
  >;
  headers: Readonly<Record<string, HeaderRule>>;
}): TransportProfile {
  return {
    retryAfter: "strict-imf",
    successStatuses: "any-2xx",
    classificationOrder: "headers-first",
    headerNames: "preserve",
    fetchInput: "url",
    abortRetryable: "timeout-only",
    redirectHeaders: [],
    contentLengthChecks: false,
    jsonContentTypes: ["application/json"],
    htmlContentTypes: [],
    challenge: null,
    headers: options.headers,
    urlGrammar: options.urlGrammar,
    cookieJar: null,
  };
}
