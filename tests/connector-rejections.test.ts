import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CONNECTOR_REJECTION_REASONS,
  ConnectorError,
  createSessionStore,
  isConnectorRejectionReason,
  parseAnonymousBootstrap,
  parseCookieJar,
  type ConnectorRejectionReason,
  type HttpClient,
} from "../packages/connectors/src/index.js";
import { civicRecPlatform } from "../packages/connectors/src/platforms/civicrec/index.js";
import { createRecordingGate } from "../packages/connectors/src/testing/index.js";
import {
  freezeClock,
  job,
  response,
  transport,
  tenant,
} from "./support/civicrec-session.js";

afterEach(() => vi.useRealTimers());

const receivedAt = "2026-11-04T12:00:00.000Z";
const cookieCases: {
  reason: ConnectorRejectionReason;
  code: "schema_changed" | "access_blocked";
  rows: string[];
  receivedAt?: string;
}[] = [
  {
    reason: "cookie_received_at",
    code: "schema_changed",
    rows: [],
    receivedAt: "invalid",
  },
  { reason: "cookie_missing", code: "schema_changed", rows: [] },
  {
    reason: "cookie_rows_limit",
    code: "schema_changed",
    rows: Array.from(
      { length: 17 },
      (_, i) => `Example${i}=example-token; Path=/`,
    ),
  },
  {
    reason: "cookie_bytes_limit",
    code: "schema_changed",
    rows: [`Example=${"x".repeat(16 * 1024)}; Path=/`],
  },
  {
    reason: "cookie_pair_invalid",
    code: "schema_changed",
    rows: ["example-token"],
  },
  {
    reason: "cookie_name_invalid",
    code: "schema_changed",
    rows: ["Example Name=example-token; Path=/"],
  },
  {
    reason: "cookie_value_invalid",
    code: "schema_changed",
    rows: ["Example=example token; Path=/"],
  },
  {
    reason: "cookie_name_duplicate",
    code: "schema_changed",
    rows: ["Example=example-token; Path=/", "Example=example-other; Path=/"],
  },
  {
    reason: "cookie_attribute_duplicate",
    code: "schema_changed",
    rows: ["Example=example-token; Path=/; PATH=/"],
  },
  {
    reason: "cookie_secure_attribute",
    code: "schema_changed",
    rows: ["Example=example-token; Path=/; Secure=yes"],
  },
  {
    reason: "cookie_max_age",
    code: "schema_changed",
    rows: ["Example=example-token; Path=/; Max-Age=invalid"],
  },
  {
    reason: "cookie_expires",
    code: "schema_changed",
    rows: ["Example=example-token; Path=/; Expires=invalid"],
  },
  {
    reason: "cookie_domain",
    code: "access_blocked",
    rows: ["Example=example-token; Path=/; Domain=example-other.invalid"],
  },
  {
    reason: "cookie_path_invalid",
    code: "access_blocked",
    rows: ["Example=example-token; Path=/invalid?path"],
  },
  {
    reason: "cookie_path_mismatch",
    code: "access_blocked",
    rows: ["Example=example-token; Path=/example-other"],
  },
  {
    reason: "cookie_partitioned",
    code: "access_blocked",
    rows: ["Example=example-token; Path=/; Partitioned"],
  },
  {
    reason: "cookie_secure_prefix",
    code: "access_blocked",
    rows: ["__Secure-Example=example-token; Path=/"],
  },
  {
    reason: "cookie_host_prefix",
    code: "access_blocked",
    rows: [
      "__Host-Example=example-token; Path=/; Domain=example.invalid; Secure",
    ],
  },
  {
    reason: "cookie_none_applicable",
    code: "access_blocked",
    rows: ["Example=example-token; Path=/; Max-Age=0"],
  },
];

function expectSafeError(
  error: unknown,
  code: string,
  reason: ConnectorRejectionReason,
) {
  expect(error).toBeInstanceOf(ConnectorError);
  expect(error).toMatchObject({
    name: "ConnectorError",
    message: code,
    code,
    retryable: false,
    retryAfterMs: null,
    rejectionReason: reason,
  });
  expect(JSON.parse(JSON.stringify(error))).toEqual({
    name: "ConnectorError",
    code,
    retryable: false,
    retryAfterMs: null,
    rejectionReason: reason,
  });
  expect(JSON.stringify(error)).not.toMatch(
    /example-token|example-other|Example=|https:/,
  );
}

describe("allowlisted rejection diagnostics", () => {
  it("preserves error semantics and accepts only finite reason IDs at runtime", () => {
    expect(Object.isFrozen(CONNECTOR_REJECTION_REASONS)).toBe(true);
    expect(new Set(CONNECTOR_REJECTION_REASONS).size).toBe(
      CONNECTOR_REJECTION_REASONS.length,
    );
    for (const reason of CONNECTOR_REJECTION_REASONS) {
      expect(isConnectorRejectionReason(reason)).toBe(true);
      const error = new ConnectorError("rate_limited", true, 23000, reason);
      expect(error).toMatchObject({
        message: "rate_limited",
        code: "rate_limited",
        retryable: true,
        retryAfterMs: 23000,
        rejectionReason: reason,
      });
    }
    const unsafe = {
      toString: () => {
        throw new Error("example-token");
      },
    };
    for (const reason of [
      undefined,
      null,
      "",
      "example-token",
      "COOKIE_DOMAIN",
      "cookie_domain example-token",
      1,
      unsafe,
      ["cookie_domain"],
      new String("cookie_domain"),
    ]) {
      expect(isConnectorRejectionReason(reason)).toBe(false);
      const error = new ConnectorError(
        "access_blocked",
        false,
        null,
        reason as ConnectorRejectionReason,
      );
      expect(error.rejectionReason).toBeUndefined();
      expect(JSON.parse(JSON.stringify(error))).toEqual({
        name: "ConnectorError",
        code: "access_blocked",
        retryable: false,
        retryAfterMs: null,
      });
      expect(String(error)).toBe("ConnectorError: access_blocked");
    }
  });

  it.each(cookieCases)(
    "identifies $reason without retaining rejected cookie data",
    ({ reason, code, rows, receivedAt: clock }) => {
      const headers = new Headers();
      for (const row of rows) headers.append("set-cookie", row);
      let failure: unknown;
      try {
        parseCookieJar(
          headers,
          new URL("https://example.invalid/XX/example-city/catalog"),
          "/XX/example-city/catalog/getFacilityHours/",
          clock ?? receivedAt,
          { cookieDomains: ["example.invalid"] },
        );
      } catch (error) {
        failure = error;
      }
      expectSafeError(failure, code, reason);
    },
  );

  it.each(cookieCases.filter(({ code }) => code === "access_blocked"))(
    "stops CivicRec setup at $reason before calendar dispatch",
    async ({ reason, rows }) => {
      freezeClock();
      const upstream = transport({
        bootstrap: () =>
          response(
            rows[0]!.replace("Domain=example.invalid", "Domain=rec1.com"),
          ),
      });
      const current = job({
        store: createSessionStore({ maxAgeMs: 60_000 }),
        fetcher: upstream.fetcher,
      });
      let failure: unknown;
      try {
        await current.read();
      } catch (error) {
        failure = error;
      }
      expectSafeError(failure, "access_blocked", reason);
      expect(upstream.requests).toEqual([{ bootstrap: true, cookie: null }]);
      expect(current.recording.calls).toHaveLength(2);
      expect(current.recording.calls[1]).toMatchObject({
        type: "release",
        outcome: { ok: true, status: 200 },
      });
    },
  );

  it("identifies the CivicRec HTML guard after successful runtime classification", async () => {
    freezeClock();
    const upstream = transport({
      bootstrap: () =>
        new Response("{}", { headers: { "content-type": "application/json" } }),
    });
    const current = job({
      store: createSessionStore({ maxAgeMs: 60_000 }),
      fetcher: upstream.fetcher,
    });
    let failure: unknown;
    try {
      await current.read();
    } catch (error) {
      failure = error;
    }
    expectSafeError(failure, "access_blocked", "bootstrap_content_type");
    expect(upstream.requests).toEqual([{ bootstrap: true, cookie: null }]);
    expect(current.recording.calls[1]).toMatchObject({
      type: "release",
      outcome: { ok: true, status: 200 },
    });
  });

  it.each([
    ["transport_redirect", () => new Response("", { status: 302 })],
    [
      "transport_redirect",
      () => {
        const item = response();
        Object.defineProperty(item, "redirected", { value: true });
        return item;
      },
    ],
    [
      "transport_redirect_header",
      () =>
        new Response("example-token", {
          headers: {
            "content-type": "text/html",
            location: "https://example.invalid/example-other",
          },
        }),
    ],
    [
      "transport_redirect_header",
      () =>
        new Response("example-token", {
          headers: {
            "content-type": "text/html",
            refresh: "0; url=https://example.invalid/example-other",
          },
        }),
    ],
    [
      "transport_auth_status",
      () => new Response("example-token", { status: 401 }),
    ],
    [
      "transport_auth_status",
      () => new Response("example-token", { status: 403 }),
    ],
    [
      "transport_content_type",
      () =>
        new Response("example-token", {
          headers: { "content-type": "text/plain" },
        }),
    ],
    [
      "transport_content_type",
      () => {
        const item = response();
        item.headers.delete("content-type");
        return item;
      },
    ],
    [
      "transport_challenge",
      () =>
        new Response("<title>Just a moment</title>example-token", {
          headers: { "content-type": "text/html" },
        }),
    ],
    [
      "transport_application_error",
      () =>
        new Response('{"error":"access denied example-token"}', {
          headers: { "content-type": "application/json" },
        }),
    ],
  ] as const)(
    "identifies %s during setup without dispatching a calendar",
    async (reason, bootstrap) => {
      freezeClock();
      const upstream = transport({ bootstrap });
      const current = job({
        store: createSessionStore({ maxAgeMs: 60_000 }),
        fetcher: upstream.fetcher,
      });
      const error = await current.read().catch((error: unknown) => error);
      expectSafeError(error, "access_blocked", reason);
      expect(upstream.requests).toEqual([{ bootstrap: true, cookie: null }]);
      expect(current.recording.calls).toHaveLength(2);
      expect(current.recording.calls[1]).toMatchObject({
        type: "release",
        outcome: {
          ok: false,
          error: "access_blocked",
          retryable: false,
          retryAfterMs: null,
        },
      });
    },
  );

  it("retains the JSON-body HTML guard on a calendar request", async () => {
    freezeClock();
    const upstream = transport({
      calendar: () =>
        new Response("<html>example-token</html>", {
          headers: { "content-type": "application/json" },
        }),
    });
    const current = job({
      store: createSessionStore({ maxAgeMs: 60_000 }),
      fetcher: upstream.fetcher,
    });
    expectSafeError(
      await current.read().catch((error: unknown) => error),
      "access_blocked",
      "transport_json_html",
    );
    expect(upstream.requests.map(({ bootstrap }) => bootstrap)).toEqual([
      true,
      false,
    ]);
  });

  it.each([
    ["bootstrap_response_invalid", { status: 201 }],
    ["bootstrap_response_invalid", { requestedAt: "x".repeat(81) }],
    ["bootstrap_chronology", { requestedAt: "invalid" }],
    [
      "bootstrap_chronology",
      { requestedAt: "2026-11-04T12:00:01Z", receivedAt },
    ],
  ] as const)(
    "identifies injected-client %s before trusting setup",
    async (reason, overrides) => {
      const request = vi.fn<HttpClient["request"]>(async () => ({
        status: 200,
        headers: response().headers,
        text: await response().text(),
        requestedAt: receivedAt,
        receivedAt,
        ...overrides,
      }));
      const connector = civicRecPlatform.createConnector({
        tenant,
        http: { request },
        now: () => new Date(receivedAt),
      });
      expectSafeError(
        await connector
          .readCourt("900003", { start: "2026-11-04", end: "2026-11-04" })
          .catch((error: unknown) => error),
        "schema_changed",
        reason,
      );
      expect(request).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["bootstrap_attributes_invalid", "<div></div>"],
    [
      "bootstrap_json_invalid",
      `<div data-page-data='{' data-base-path='/XX/example-city/'></div>`,
    ],
    [
      "bootstrap_checkout_invalid",
      `<div data-page-data='{}' data-base-path='/XX/example-city/'></div>`,
    ],
    [
      "bootstrap_checkout_invalid",
      `<div data-page-data='{"checkoutData":{"user":true,"key":"example-token"}}' data-base-path='/XX/example-city/'></div>`,
    ],
  ] as const)(
    "identifies %s without reflecting setup content",
    async (reason, html) => {
      freezeClock();
      const upstream = transport({
        bootstrap: () => new Response(html, { headers: response().headers }),
      });
      const current = job({
        store: createSessionStore({ maxAgeMs: 60_000 }),
        fetcher: upstream.fetcher,
      });
      expectSafeError(
        await current.read().catch((error: unknown) => error),
        "schema_changed",
        reason,
      );
      expect(upstream.requests).toEqual([{ bootstrap: true, cookie: null }]);
    },
  );

  it("identifies invalid bootstrap context before parsing attributes", async () => {
    let failure: unknown;
    try {
      parseAnonymousBootstrap({
        html: await response().text(),
        headers: response().headers,
        catalogUrl: new URL(
          "https://example.invalid/XX/example-city/catalog?example-token",
        ),
        receivedAt,
        cookieDomains: ["example.invalid"],
      });
    } catch (error) {
      failure = error;
    }
    expectSafeError(failure, "schema_changed", "bootstrap_context_invalid");
  });

  it("drops arbitrary diagnostic values while normalizing runtime failures", async () => {
    freezeClock();
    for (const reason of [
      "example-token",
      { detail: "example-token" },
      undefined,
    ]) {
      const upstream = transport();
      const current = job({
        store: createSessionStore({ maxAgeMs: 60_000 }),
        fetcher: upstream.fetcher,
        profile: {
          ...civicRecPlatform.transport,
          classify() {
            throw {
              name: "ConnectorError",
              code: "rate_limited",
              retryable: true,
              retryAfterMs: 23000,
              rejectionReason: reason,
              message: "example-token",
            };
          },
        },
      });
      const error = await current.read().catch((error: unknown) => error);
      expect(JSON.parse(JSON.stringify(error))).toEqual({
        name: "ConnectorError",
        code: "rate_limited",
        retryable: true,
        retryAfterMs: 23000,
      });
      expect(String(error)).toBe("ConnectorError: rate_limited");
      expect(upstream.requests).toEqual([{ bootstrap: true, cookie: null }]);
    }
  });

  it.each([
    [
      401,
      "<title>Just a moment</title>example-token",
      "access_blocked",
      "transport_challenge",
    ],
    [
      400,
      "<title>Just a moment</title>example-token",
      "access_blocked",
      "transport_challenge",
    ],
    [
      503,
      "<title>Just a moment</title>example-token",
      "access_blocked",
      "transport_challenge",
    ],
    [
      403,
      "<title>Just a moment</title>example-token",
      "access_blocked",
      "transport_auth_status",
    ],
    [
      429,
      "<title>Just a moment</title>example-token",
      "rate_limited",
      undefined,
    ],
    [401, "example-token", "http_error", undefined],
  ] as const)(
    "preserves guarded setup classification at HTTP %s",
    async (status, body, code, rejectionReason) => {
      freezeClock();
      const upstream = transport({
        bootstrap: () =>
          new Response(body, {
            status,
            headers: { "content-type": "text/html" },
          }),
      });
      const recording = createRecordingGate();
      const current = job({
        store: createSessionStore({ maxAgeMs: 60_000 }),
        fetcher: upstream.fetcher,
        gate: {
          ...recording.gate,
          dispatch(_ticket, _request, send) {
            return send(() => {});
          },
        },
      });
      const error = await current.read().catch((error: unknown) => error);
      expect(error).toMatchObject({
        code,
        retryable: false,
        retryAfterMs: null,
        rejectionReason,
      });
      expect(JSON.stringify(error)).not.toContain("example-token");
      expect(upstream.requests).toEqual([{ bootstrap: true, cookie: null }]);
      expect(recording.calls).toHaveLength(2);
      expect(recording.calls[1]).toMatchObject({
        type: "release",
        outcome: {
          ok: false,
          status,
          error: code,
          retryable: false,
          retryAfterMs: null,
        },
      });
    },
  );
});
