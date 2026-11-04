import { describe, expect, it, vi } from "vitest";
import {
  activeNetLegacyProfile,
  createConnectorRuntime,
  civicRecLegacyProfile,
  ConnectorError,
  defaultTransportProfile,
} from "../packages/connectors/src/index.js";
import type { Gate } from "../packages/connectors/src/index.js";
import { createRecordingGate } from "../packages/connectors/src/testing/index.js";
import {
  activeRequest,
  activeTenant,
  bootstrapRequest,
  civicRequest,
  civicTenant,
  runtime,
} from "./runtime-support.js";

describe("runtime request and lease behavior", () => {
  it("pins the legacy transport profile differences", () => {
    expect(activeNetLegacyProfile).toMatchObject({
      retryAfter: "strict-imf",
      successStatuses: "any-2xx",
      classificationOrder: "headers-first",
      headerNames: "lowercase",
      fetchInput: "url",
      abortRetryable: "timeout-only",
      redirectHeaders: [],
      readBodyOnlyOnSuccess: false,
      contentLengthChecks: false,
      jsonContentTypes: ["application/json"],
      challenge: null,
      cookieJar: null,
    });
    expect(civicRecLegacyProfile).toMatchObject({
      retryAfter: "lenient",
      successStatuses: "200-only",
      classificationOrder: "legacy-body-first",
      headerNames: "lowercase",
      fetchInput: "string",
      abortRetryable: "any-abort",
      redirectHeaders: ["location", "refresh"],
      readBodyOnlyOnSuccess: true,
      contentLengthChecks: true,
      jsonContentTypes: ["application/json", "text/json"],
      htmlContentTypes: ["text/html"],
      challenge: { scope: "all" },
    });
    const recording = createRecordingGate();
    const fetcher = vi.fn<typeof fetch>(async () => new Response());
    for (const unsupported of [
      { maxCookies: 1 },
      { maxBytes: 16383 },
      { rejectPartitioned: false },
      { enforceSecurePrefixes: false },
    ]) {
      const profile = {
        ...civicRecLegacyProfile,
        cookieJar: { ...civicRecLegacyProfile.cookieJar!, ...unsupported },
      };
      expect(() =>
        createConnectorRuntime({
          tenant: civicTenant,
          profile: profile as typeof civicRecLegacyProfile,
          gate: recording.gate,
          fetch: fetcher,
          now: () => new Date(),
          leaseScope: "per_request",
        }),
      ).toThrowError(expect.objectContaining({ code: "schema_changed" }));
    }
    expect(recording.calls).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("preserves the ActiveNet request form and per-read parser outcome", async () => {
    const recording = createRecordingGate();
    let inputSeen: RequestInfo | URL | undefined;
    let initSeen: RequestInit | undefined;
    const fetcher: typeof fetch = async (input, init) => {
      inputSeen = input;
      initSeen = init;
      return new Response("{}", {
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    };
    const client = runtime(
      activeTenant,
      activeNetLegacyProfile,
      recording.gate,
      fetcher,
      { leaseScope: "per_read", monotonicNow: () => 0 },
    );
    const request = activeRequest();
    request.headers = { Accept: "application/json" };
    await expect(
      client.execute(async () => {
        expect((await client.http.request(request)).text).toBe("{}");
        expect(recording.calls).toHaveLength(1);
        throw new ConnectorError("access_blocked");
      }),
    ).rejects.toMatchObject({ code: "access_blocked" });
    expect(inputSeen).toBeInstanceOf(URL);
    expect(initSeen).toMatchObject({
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "omit",
      redirect: "manual",
      cache: "no-store",
      signal: expect.any(AbortSignal),
    });
    expect(recording.calls).toEqual([
      {
        type: "acquire",
        request: {
          court: request.court,
          purpose: request.purpose,
          method: request.method,
          url: request.url.href,
        },
      },
      {
        type: "release",
        ticket: 1,
        outcome: {
          ok: false,
          status: 200,
          error: "access_blocked",
          retryAfterMs: null,
        },
      },
    ]);
  });

  it("rejects a second per-read request before admission and releases once with the error", async () => {
    const recording = createRecordingGate();
    let fetches = 0;
    const fetcher: typeof fetch = async () => {
      fetches += 1;
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    };
    const client = runtime(
      activeTenant,
      activeNetLegacyProfile,
      recording.gate,
      fetcher,
      { leaseScope: "per_read" },
    );
    await expect(
      client.execute(async () => {
        await client.http.request(activeRequest());
        await client.http.request(activeRequest());
      }),
    ).rejects.toMatchObject({ code: "schema_changed" });
    expect(fetches).toBe(1);
    expect(recording.calls).toHaveLength(2);
    expect(recording.calls[1]).toEqual({
      type: "release",
      ticket: 1,
      outcome: {
        ok: false,
        status: 200,
        error: "schema_changed",
        retryAfterMs: null,
      },
    });
  });

  it("does not release an in-flight per-read request when a concurrent second request is rejected", async () => {
    const recording = createRecordingGate();
    let resolveFetch: ((response: Response) => void) | undefined;
    let fetches = 0;
    const fetcher: typeof fetch = () => {
      fetches += 1;
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    };
    const client = runtime(
      activeTenant,
      activeNetLegacyProfile,
      recording.gate,
      fetcher,
      { leaseScope: "per_read" },
    );
    const result = client
      .execute(() =>
        Promise.all([
          client.http.request(activeRequest()),
          client.http.request(activeRequest()),
        ]),
      )
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(resolveFetch).toBeTypeOf("function"));
    expect(recording.calls).toHaveLength(1);
    resolveFetch!(
      new Response("{}", { headers: { "content-type": "application/json" } }),
    );
    expect(await result).toMatchObject({ code: "schema_changed" });
    expect(fetches).toBe(1);
    expect(recording.calls).toHaveLength(2);
    expect(recording.calls[1]).toMatchObject({
      type: "release",
      ticket: 1,
      outcome: { ok: false, error: "schema_changed" },
    });
  });

  it("preserves CivicRec header values and releases each classified request", async () => {
    const recording = createRecordingGate();
    let inputSeen: RequestInfo | URL | undefined;
    let initSeen: RequestInit | undefined;
    let fetchCount = 0;
    const fetcher: typeof fetch = async (input, init) => {
      inputSeen = input;
      initSeen = init;
      fetchCount += 1;
      if (fetchCount === 1) {
        const headers = new Headers({ "content-type": "text/html" });
        headers.append(
          "set-cookie",
          "ExampleSession=example-token; Path=/; Secure",
        );
        headers.append("set-cookie", "ExampleOther=two; Path=/; Secure");
        return new Response("<html></html>", { headers });
      }
      const headers = new Headers({
        "content-type": "text/json; charset=utf-8",
      });
      headers.append("set-cookie", "ExampleSession=changed; Path=/; Secure");
      return new Response("{}", { headers });
    };
    const request = civicRequest();
    request.headers = {
      Accept: "application/json",
      Cookie: "ExampleSession=example-token; ExampleOther=two",
      "X-Requested-With": "XMLHttpRequest",
    };
    const client = runtime(
      civicTenant,
      civicRecLegacyProfile,
      recording.gate,
      fetcher,
      { monotonicNow: () => 12 },
    );
    await expect(
      client.execute(() => client.http.request(request)),
    ).rejects.toMatchObject({ code: "schema_changed" });
    expect(recording.calls).toEqual([]);
    expect(fetchCount).toBe(0);
    await client.execute(() => client.http.request(bootstrapRequest()));
    const response = await client.execute(() => client.http.request(request));
    expect(inputSeen).toBe(request.url.href);
    expect(initSeen).toMatchObject({
      headers: {
        accept: "application/json",
        cookie: "ExampleSession=example-token; ExampleOther=two",
        "x-requested-with": "XMLHttpRequest",
      },
      credentials: "omit",
      redirect: "manual",
      cache: "no-store",
    });
    expect(response.requestedAt).toBe("2026-11-04T12:00:00.000Z");
    expect(response.receivedAt).toBe(response.requestedAt);
    expect(recording.calls.at(-1)).toEqual({
      type: "release",
      ticket: 2,
      outcome: { ok: true, status: 200 },
    });
    request.headers.Cookie = "ExampleSession=changed";
    await expect(
      client.execute(() => client.http.request(request)),
    ).rejects.toMatchObject({ code: "schema_changed" });
    expect(fetchCount).toBe(2);
  });

  it("keeps bootstrap cookie lifetime semantics without absorbing later cookies", async () => {
    const recording = createRecordingGate();
    let time = Date.parse("2026-11-04T12:00:00.000Z");
    let count = 0;
    const fetcher: typeof fetch = async () => {
      count += 1;
      if (count === 1) {
        const headers = new Headers({ "content-type": "text/html" });
        headers.append(
          "set-cookie",
          "ExampleSession=example-token; Path=/; Secure; Max-Age=1",
        );
        return new Response("<html></html>", { headers });
      }
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    };
    const client = createConnectorRuntime({
      tenant: civicTenant,
      profile: civicRecLegacyProfile,
      leaseScope: "per_request",
      gate: recording.gate,
      fetch: fetcher,
      now: () => new Date(time),
      monotonicNow: () => 0,
    });
    await client.execute(() => client.http.request(bootstrapRequest()));
    time += 60000;
    const request = civicRequest();
    request.headers!.cookie = "ExampleSession=example-token";
    expect(
      (await client.execute(() => client.http.request(request))).status,
    ).toBe(200);
    expect(count).toBe(2);
  });

  it("checks the outgoing path against the bootstrap cookie scope", async () => {
    const recording = createRecordingGate();
    let count = 0;
    const fetcher: typeof fetch = async () => {
      count += 1;
      if (count === 1) {
        const headers = new Headers({ "content-type": "text/html" });
        headers.append(
          "set-cookie",
          "ExampleSession=example-token; Path=/XX/example-city/catalog/getFacilityHours/; Secure",
        );
        return new Response("<html></html>", { headers });
      }
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    };
    const client = runtime(
      civicTenant,
      civicRecLegacyProfile,
      recording.gate,
      fetcher,
    );
    await client.execute(() => client.http.request(bootstrapRequest()));
    const request = civicRequest();
    request.headers!.cookie = "ExampleSession=example-token";
    await client.execute(() => client.http.request(request));
    const metadata = {
      ...request,
      purpose: "metadata" as const,
      url: new URL(
        `${civicTenant.origin}/XX/example-city/catalog/getFacilityRates/example-session/900003/2026-11-04`,
      ),
    };
    await expect(
      client.execute(() => client.http.request(metadata)),
    ).rejects.toMatchObject({ code: "schema_changed" });
    expect(count).toBe(2);
    expect(recording.calls).toHaveLength(4);
  });

  it("rejects invalid origins, grammar and bootstrap headers before a gate call", async () => {
    const recording = createRecordingGate();
    let fetches = 0;
    const fetcher: typeof fetch = async () => {
      fetches += 1;
      return new Response("{}");
    };
    const client = runtime(
      civicTenant,
      civicRecLegacyProfile,
      recording.gate,
      fetcher,
    );
    const invalid = [
      {
        ...civicRequest(),
        url: new URL("https://other.example.invalid/XX/example-city/catalog"),
      },
      {
        ...civicRequest(),
        url: new URL(`${civicTenant.origin}/XX/example-city/catalog/checkout`),
      },
      {
        ...bootstrapRequest(),
        url: new URL(`${civicTenant.origin}/XX/example-city/catalog?`),
      },
      {
        ...bootstrapRequest(),
        url: new URL(`${civicTenant.origin}/XX/example-city/catalog#`),
      },
      { ...civicRequest(), method: "POST" as const },
      {
        ...bootstrapRequest(),
        headers: {
          accept: "text/html",
          cookie: "ExampleSession=example-token",
        },
      },
      {
        ...civicRequest(),
        headers: {
          accept: "application/json",
          "x-requested-with": "different",
        },
      },
      {
        ...civicRequest(),
        headers: { accept: "application/json", constructor: "example" },
      },
      {
        ...civicRequest(),
        url: new URL(
          `${civicTenant.origin}/XX/example-city/catalog/getFacilityHours/${"x".repeat(1025)}/900003/900004/2026-11-04`,
        ),
      },
      {
        ...civicRequest(),
        url: new URL(
          `${civicTenant.origin}/XX/example-city/catalog/getFacilityHours/example-session/0/900004/2026-11-04`,
        ),
      },
      {
        ...civicRequest(),
        url: new URL(
          `${civicTenant.origin}/XX/example-city/catalog/getFacilityHours/example-session/900003/900004/2026-02-30`,
        ),
      },
      {
        ...civicRequest(),
        headers: { accept: "application/json", authorization: "example" },
      },
      ...["referer", "origin", "user-agent"].map((name) => ({
        ...civicRequest(),
        headers: { accept: "application/json", [name]: "example" },
      })),
      {
        ...civicRequest(),
        headers: { accept: "application/json", cookie: "example\r\nexample" },
      },
      {
        ...civicRequest(),
        headers: {
          accept: "application/json",
          cookie: "x".repeat(16 * 1024 + 1),
        },
      },
      { ...bootstrapRequest(), headers: { accept: "x".repeat(257) } },
      {
        ...bootstrapRequest(),
        headers: { accept: "text/html", Accept: "text/html" },
      },
      { ...bootstrapRequest(), headers: {} },
    ];
    for (const request of invalid)
      await expect(
        client.execute(() => client.http.request(request)),
      ).rejects.toMatchObject({ code: "schema_changed" });
    expect(recording.calls).toEqual([]);
    expect(fetches).toBe(0);
    const longCatalog = `/XX/example-${"a".repeat(250)}/catalog`;
    const longTenant = {
      ...civicTenant,
      params: { catalogPath: longCatalog, locationId: "900001" },
    };
    const longClient = runtime(
      longTenant,
      civicRecLegacyProfile,
      recording.gate,
      fetcher,
    );
    await expect(
      longClient.execute(() =>
        longClient.http.request({
          ...bootstrapRequest(),
          url: new URL(`${longTenant.origin}${longCatalog}`),
        }),
      ),
    ).rejects.toMatchObject({ code: "schema_changed" });
    expect(recording.calls).toEqual([]);
    expect(fetches).toBe(0);
    const active = runtime(
      activeTenant,
      activeNetLegacyProfile,
      recording.gate,
      fetcher,
    );
    const changed = activeRequest();
    changed.url.searchParams.append("extra", "example");
    await expect(
      active.execute(() => active.http.request(changed)),
    ).rejects.toMatchObject({ code: "schema_changed" });
    expect(recording.calls).toEqual([]);
    const badRange = activeRequest();
    badRange.url.searchParams.set("end_date", "2026-11-01");
    await expect(
      active.execute(() => active.http.request(badRange)),
    ).rejects.toMatchObject({ code: "schema_changed" });
    expect(recording.calls).toEqual([]);
  });

  it("snapshots the request before waiting for the gate", async () => {
    let admit!: (ticket: object) => void;
    const gate: Gate = {
      acquire: () =>
        new Promise((resolve) => {
          admit = resolve;
        }),
      release: async () => {},
    };
    let urlSeen = "";
    let headersSeen: HeadersInit | undefined;
    const fetcher: typeof fetch = async (url, init) => {
      urlSeen = String(url);
      headersSeen = init?.headers;
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    };
    const request = activeRequest();
    const originalUrl = request.url.href;
    const client = runtime(activeTenant, activeNetLegacyProfile, gate, fetcher);
    const pending = client.execute(() => client.http.request(request));
    request.url.pathname = "/changed";
    request.headers!.accept = "changed";
    admit({});
    await pending;
    expect(urlSeen).toBe(originalUrl);
    expect(headersSeen).toEqual({ accept: "application/json" });
  });

  it("derives received time from monotonic elapsed time", async () => {
    let clock = 100;
    const recording = createRecordingGate();
    const fetcher: typeof fetch = async () => {
      clock += 25;
      return new Response("{}", {
        headers: { "content-type": "application/json" },
      });
    };
    const client = runtime(
      activeTenant,
      activeNetLegacyProfile,
      recording.gate,
      fetcher,
      { leaseScope: "per_read", monotonicNow: () => clock },
    );
    const result = await client.execute(() =>
      client.http.request(activeRequest()),
    );
    expect(result.requestedAt).toBe("2026-11-04T12:00:00.000Z");
    expect(result.receivedAt).toBe("2026-11-04T12:00:00.025Z");
  });

  it("lets acquire errors pass unchanged and supports a constrained default profile", async () => {
    const denied = new Error("example control flow");
    let released = false;
    let fetched = false;
    const gate: Gate = {
      acquire: async () => {
        throw denied;
      },
      release: async () => {
        released = true;
      },
    };
    const fetcher: typeof fetch = async () => {
      fetched = true;
      return new Response("{}");
    };
    const profile = defaultTransportProfile({
      headers: { accept: { required: true } },
      urlGrammar: { GET: () => true },
    });
    const client = runtime(activeTenant, profile, gate, fetcher, {
      leaseScope: "per_read",
    });
    await expect(
      client.execute(() => client.http.request(activeRequest())),
    ).rejects.toBe(denied);
    expect(released).toBe(false);
    expect(fetched).toBe(false);
    expect(() =>
      createConnectorRuntime({
        tenant: activeTenant,
        profile,
        gate,
        fetch: fetcher,
        now: () => new Date(),
        leaseScope: "invalid" as "per_read",
      }),
    ).toThrowError(expect.objectContaining({ code: "schema_changed" }));
  });
});
