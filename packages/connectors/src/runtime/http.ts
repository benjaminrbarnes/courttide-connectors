import { AsyncLocalStorage } from "node:async_hooks";
import { ConnectorError } from "../contract/errors.js";
import {
  TenantConfigSchema,
  TransportProfileSchema,
} from "../contract/schemas.js";
import type {
  ConnectorErrorCode,
  Gate,
  GateOutcome,
  GateTicket,
  HttpClient,
  HttpRequest,
  TenantConfig,
  TransportProfile,
} from "../contract/types.js";
import { bounded, isTimeoutError } from "./async.js";
import { parseCookieJar } from "./cookies.js";
import { snapshotRequest } from "./request.js";
import { processResponse } from "./response.js";

const TIMEOUT_MS = 15_000;
const errorCodes = new Set<ConnectorErrorCode>([
  "auth_required",
  "http_error",
  "rate_limited",
  "access_blocked",
  "schema_changed",
  "identity_mismatch",
  "date_coverage_incomplete",
  "invalid_interval",
  "unsupported_time",
]);

export interface RuntimeOptions {
  tenant: TenantConfig;
  profile: TransportProfile;
  leaseScope: "per_read" | "per_request";
  gate: Gate;
  fetch: typeof fetch;
  now: () => Date;
  signal?: AbortSignal;
  monotonicNow?: () => number;
}
export interface ConnectorRuntime {
  http: HttpClient;
  execute<T>(operation: () => Promise<T>): Promise<T>;
}
interface ReadScope {
  tickets: GateTicket[];
  requestStarted: boolean;
  pending: Set<Promise<void>>;
  status?: number;
}
interface CookieProof {
  headers: Headers;
  url: URL;
  endpointPath: string;
  receivedAt: string;
}

function safeError(error: unknown, retryable: boolean): ConnectorError {
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "ConnectorError" &&
    "code" in error &&
    typeof error.code === "string" &&
    errorCodes.has(error.code as ConnectorErrorCode)
  ) {
    const retryable = "retryable" in error && error.retryable === true;
    const delay =
      "retryAfterMs" in error &&
      typeof error.retryAfterMs === "number" &&
      Number.isFinite(error.retryAfterMs) &&
      error.retryAfterMs >= 0
        ? error.retryAfterMs
        : null;
    return new ConnectorError(
      error.code as ConnectorErrorCode,
      retryable,
      delay,
    );
  }
  return new ConnectorError("http_error", retryable);
}

function gateOutcome(
  success: boolean,
  error: unknown,
  status?: number,
): GateOutcome {
  if (success) return { ok: true, ...(status === undefined ? {} : { status }) };
  if (
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "ConnectorError" &&
    "code" in error &&
    typeof error.code === "string" &&
    errorCodes.has(error.code as ConnectorErrorCode)
  ) {
    const delay =
      "retryAfterMs" in error &&
      typeof error.retryAfterMs === "number" &&
      Number.isFinite(error.retryAfterMs) &&
      error.retryAfterMs >= 0
        ? error.retryAfterMs
        : null;
    return {
      ok: false,
      ...(status === undefined ? {} : { status }),
      error: error.code as ConnectorErrorCode,
      retryAfterMs: delay,
      retryable: "retryable" in error && error.retryable === true,
    };
  }
  return {
    ok: false,
    ...(status === undefined ? {} : { status }),
    error: "http_error",
    retryable: false,
  };
}

export function createConnectorRuntime(
  options: RuntimeOptions,
): ConnectorRuntime {
  if (
    !options ||
    !TenantConfigSchema.safeParse(options.tenant).success ||
    !TransportProfileSchema.safeParse(options.profile).success ||
    !["per_read", "per_request"].includes(options.leaseScope) ||
    typeof options.gate?.acquire !== "function" ||
    typeof options.gate?.release !== "function" ||
    typeof options.fetch !== "function" ||
    typeof options.now !== "function" ||
    (options.monotonicNow !== undefined &&
      typeof options.monotonicNow !== "function") ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  )
    throw new ConnectorError("schema_changed");
  const scopes = new AsyncLocalStorage<ReadScope>();
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const cookieProofs: CookieProof[] = [];
  async function releaseRequest(ticket: GateTicket, outcome: GateOutcome) {
    try {
      await options.gate.release(ticket, outcome);
    } catch (error) {
      throw safeError(error, false);
    }
  }
  const http: HttpClient = {
    async request(input: HttpRequest) {
      const request = snapshotRequest(input, options.tenant, options.profile);
      const cookie = Object.entries(request.headers ?? {}).find(
        ([name]) => name.toLowerCase() === "cookie",
      )?.[1];
      if (cookie !== undefined) {
        const jar = options.profile.cookieJar;
        const issued =
          jar &&
          cookieProofs.some((proof) => {
            try {
              return (
                parseCookieJar(
                  proof.headers,
                  proof.url,
                  proof.endpointPath,
                  proof.receivedAt,
                  { cookieDomains: jar.cookieDomains },
                ).header === cookie &&
                parseCookieJar(
                  proof.headers,
                  proof.url,
                  request.url.pathname,
                  proof.receivedAt,
                  { cookieDomains: jar.cookieDomains },
                ).header === cookie
              );
            } catch {
              return false;
            }
          });
        if (!issued) throw new ConnectorError("schema_changed");
      }
      const scope =
        options.leaseScope === "per_read" ? scopes.getStore() : undefined;
      if (options.leaseScope === "per_read" && !scope)
        throw new ConnectorError("schema_changed");
      if (scope) {
        if (scope.requestStarted) throw new ConnectorError("schema_changed");
        scope.requestStarted = true;
        let settle!: () => void;
        const done = new Promise<void>((resolve) => {
          settle = resolve;
        });
        scope.pending.add(done);
        try {
          return await performRequest(request, scope);
        } finally {
          scope.pending.delete(done);
          settle();
        }
      }
      return performRequest(request);
    },
  };

  async function performRequest(request: HttpRequest, scope?: ReadScope) {
    const ticket = await options.gate.acquire({
      court: request.court,
      purpose: request.purpose,
      method: request.method,
      url: request.url.href,
    });
    scope?.tickets.push(ticket);
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const timer = setTimeout(
      () =>
        controller.abort(new DOMException("Request timed out", "TimeoutError")),
      TIMEOUT_MS,
    );
    let status: number | undefined;
    let failure: ConnectorError | undefined;
    let response: Response | undefined;
    try {
      const wallStart = options.now().getTime();
      const monoStart = monotonicNow();
      if (!Number.isFinite(wallStart) || !Number.isFinite(monoStart))
        throw new ConnectorError("schema_changed");
      const deadline = () => {
        if (!signal.aborted && monotonicNow() - monoStart >= TIMEOUT_MS)
          controller.abort(
            new DOMException("Request timed out", "TimeoutError"),
          );
        if (signal.aborted) throw signal.reason;
      };
      const receivedAt = () =>
        new Date(
          wallStart + Math.max(0, monotonicNow() - monoStart),
        ).toISOString();
      deadline();
      const url =
        options.profile.fetchInput === "string"
          ? request.url.href
          : request.url;
      const fetching = options.fetch(url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        credentials: "omit",
        redirect: "manual",
        cache: "no-store",
        signal,
      });
      void fetching
        .then(
          async (late) => {
            if (signal.aborted) await late.body?.cancel().catch(() => {});
          },
          () => {},
        )
        .catch(() => {});
      response = await bounded(fetching, signal);
      if (!(response instanceof Response))
        throw new ConnectorError("schema_changed");
      status = response.status;
      if (scope) scope.status = status;
      deadline();
      const result = await processResponse(
        response,
        request,
        options.profile,
        { now: options.now, receivedAt, deadline, signal },
        new Date(wallStart).toISOString(),
      );
      if (
        request.purpose === "bootstrap" &&
        options.profile.cookieJar &&
        result.headers.getSetCookie().length
      ) {
        const headers = new Headers();
        for (const row of result.headers.getSetCookie())
          headers.append("set-cookie", row);
        cookieProofs.push({
          headers,
          url: new URL(request.url.href),
          endpointPath: options.profile.cookieJar.pathFor(request),
          receivedAt: result.receivedAt,
        });
      }
      return result;
    } catch (error) {
      failure = safeError(
        error,
        isTimeoutError(error, signal, options.profile.abortRetryable),
      );
      throw failure;
    } finally {
      if (response instanceof Response)
        await response.body?.cancel().catch(() => {});
      clearTimeout(timer);
      controller.abort();
      if (options.leaseScope === "per_request")
        await releaseRequest(
          ticket,
          gateOutcome(failure === undefined, failure, status),
        );
    }
  }
  return {
    http,
    async execute<T>(operation: () => Promise<T>): Promise<T> {
      if (options.leaseScope === "per_request") return operation();
      const scope: ReadScope = {
        tickets: [],
        requestStarted: false,
        pending: new Set(),
      };
      return scopes.run(scope, async () => {
        let failure: unknown;
        let success = false;
        let result: T | undefined;
        try {
          result = await operation();
          success = true;
        } catch (error) {
          failure = error;
        }
        await Promise.all(scope.pending);
        let releaseFailure: unknown;
        let releaseFailed = false;
        for (const ticket of scope.tickets) {
          try {
            await options.gate.release(
              ticket,
              gateOutcome(success, failure, scope.status),
            );
          } catch (error) {
            if (!releaseFailed) releaseFailure = error;
            releaseFailed = true;
          }
        }
        if (releaseFailed) throw releaseFailure;
        if (!success) throw failure;
        return result as T;
      });
    },
  };
}
