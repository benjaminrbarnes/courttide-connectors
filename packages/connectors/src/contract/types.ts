import type { ZodType } from "zod";
import type { ATTRIBUTION } from "./constants.js";

export type PlatformId = string;
export type TenantKey = string;
export type CourtKey = string;
export type LocalDate = string;
export type Instant = string;
export type ReadShape = "full_calendar" | "continuous_ranges";
export type RequestPurpose = "calendar" | "identity" | "bootstrap" | "metadata";
export type RequestMethod = "GET" | "POST";

export interface ParserIdentity {
  id: string;
  version: string;
  signature: string;
}

export interface TenantConfig<TTenantParams = unknown, TCourtParams = unknown> {
  schemaVersion: "1";
  platform: PlatformId;
  tenant: TenantKey;
  timeZone: string;
  origin: string;
  params: TTenantParams;
  parks: {
    key: string;
    name: string;
    courttideSlug?: string;
    publicTimes?: boolean;
    courts: {
      key: CourtKey;
      label: string;
      platformLabel?: string;
      retired?: LocalDate;
      params: TCourtParams;
    }[];
  }[];
}

export interface Capabilities {
  auth: "none";
  shape: ReadShape;
  maxDaysPerRead: number;
  leaseScope: "per_read" | "per_request";
  requests: { perRead: number; perSessionBootstrap: number };
  minimumGapMs: number;
  identity: "label_check" | "none";
  bookingWrites: false;
}

export interface ConnectorContext<
  TTenantParams = unknown,
  TCourtParams = unknown,
> {
  tenant: TenantConfig<TTenantParams, TCourtParams>;
  courts?: CourtKey[];
  http: HttpClient;
  now: () => Date;
  signal?: AbortSignal;
}

export interface Connector {
  readonly capabilities: Capabilities;
  readCourt(
    court: CourtKey,
    range: { start: LocalDate; end: LocalDate },
  ): Promise<CourtReading>;
  verifyCourt?(
    court: CourtKey,
  ): Promise<{ court: CourtKey; platformLabel: string }>;
}

export interface Platform<TTenantParams = unknown, TCourtParams = unknown> {
  id: PlatformId;
  parser: ParserIdentity;
  tenantParams: ZodType<TTenantParams>;
  courtParams: ZodType<TCourtParams>;
  transport: TransportProfile;
  capabilities(tenant: TenantConfig<TTenantParams, TCourtParams>): Capabilities;
  createConnector(
    context: ConnectorContext<TTenantParams, TCourtParams>,
  ): Connector;
}

export interface Evidence {
  kind: "continuous_ranges";
  scope: "reported_ranges_only";
  startIncrementMinutes: 5 | 15;
  startAnchor: "local_midnight" | "range_start";
  minimumOccupiedMinutes: number;
  durationStepMinutes: number;
  maximumOccupiedMinutes?: number;
}

export interface Interval {
  start: Instant;
  end: Instant;
  available: boolean;
}

export interface DayReading {
  date: LocalDate;
  observedAt?: Instant;
  status: number;
  visibility: "visible" | "hidden_or_unavailable" | "unknown";
  coverage: "complete" | "partial" | "invalid";
  usable: boolean;
  reasonCodes: string[];
  intervals: Interval[];
  evidence?: Evidence;
}

export interface CourtReading {
  platform: PlatformId;
  tenant: TenantKey;
  court: CourtKey;
  startDate: LocalDate;
  endDate: LocalDate;
  complete: boolean;
  observedAt: Instant;
  sourceUrl: string;
  days: DayReading[];
  sanitized: unknown;
  parser: ParserIdentity;
  attribution: {
    text: typeof ATTRIBUTION.text;
    url: typeof ATTRIBUTION.url;
    parkUrl?: string;
  };
}

export type ConnectorErrorCode =
  | "auth_required"
  | "http_error"
  | "rate_limited"
  | "access_blocked"
  | "schema_changed"
  | "identity_mismatch"
  | "date_coverage_incomplete"
  | "invalid_interval"
  | "unsupported_time";

export interface GateRequest {
  court: CourtKey;
  purpose: RequestPurpose;
  method: RequestMethod;
  url: string;
}
export type GateTicket = unknown;
export interface GateOutcome {
  ok: boolean;
  status?: number;
  error?: ConnectorErrorCode;
  retryAfterMs?: number | null;
  retryable?: boolean;
}
export interface Gate {
  acquire(request: GateRequest): Promise<GateTicket>;
  release(ticket: GateTicket, outcome: GateOutcome): Promise<void>;
}

export interface HttpRequest {
  court: CourtKey;
  purpose: RequestPurpose;
  method: RequestMethod;
  url: URL;
  headers?: Record<string, string>;
  body?: string;
  expect: "json" | "html";
}
export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  requestedAt: Instant;
  receivedAt: Instant;
}
export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export interface HeaderRule {
  required?: boolean;
  exact?: string;
  maxLength?: number;
  forbiddenPurposes?: readonly RequestPurpose[];
}
export interface CookieJarProfile {
  cookieDomains: readonly string[];
  maxCookies: 16;
  maxBytes: 16384;
  rejectPartitioned: true;
  enforceSecurePrefixes: true;
  pathFor(request: HttpRequest): string;
}
export interface TransportProfile {
  retryAfter: "strict-imf" | "lenient";
  successStatuses: "any-2xx" | "200-only";
  classificationOrder: "headers-first" | "legacy-body-first";
  headerNames: "preserve" | "lowercase";
  fetchInput: "url" | "string";
  abortRetryable: "timeout-only" | "any-abort";
  redirectHeaders: readonly string[];
  contentLengthChecks: boolean;
  jsonContentTypes: readonly string[];
  htmlContentTypes: readonly string[];
  classifyJsonForHtml?: boolean;
  challenge: {
    passiveAssets: readonly string[];
    scope: "html-or-leading" | "all";
  } | null;
  headers: Readonly<Record<string, HeaderRule>>;
  urlGrammar: Partial<
    Record<
      RequestMethod,
      (url: URL, tenant: TenantConfig, purpose: RequestPurpose) => boolean
    >
  >;
  cookieJar: CookieJarProfile | null;
  classify?: (body: unknown, request: HttpRequest) => void | Promise<void>;
}
