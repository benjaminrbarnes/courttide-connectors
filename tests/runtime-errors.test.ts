import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activeNetLegacyProfile,
  bootstrapAttributes,
  civicRecLegacyProfile,
  ConnectorError,
  parseAnonymousBootstrap,
} from "../packages/connectors/src/index.js";
import type {
  Gate,
  HttpRequest,
  TenantConfig,
  TransportProfile,
} from "../packages/connectors/src/index.js";
import { createRecordingGate } from "../packages/connectors/src/testing/index.js";
import {
  activeRequest,
  activeTenant,
  bootstrapRequest,
  civicRequest,
  civicTenant,
  runtime,
} from "./runtime-support.js";

afterEach(() => vi.useRealTimers());

async function run(
  response: Response,
  tenant: TenantConfig,
  profile: TransportProfile,
  request: HttpRequest,
) {
  const recording = createRecordingGate();
  let fetches = 0;
  const fetcher: typeof fetch = async () => {
    fetches += 1;
    return response;
  };
  const client = runtime(tenant, profile, recording.gate, fetcher, {
    monotonicNow: () => 0,
  });
  const result = await client
    .execute(() => client.http.request(request))
    .catch((error: unknown) => error);
  return { result, calls: recording.calls, fetches };
}

describe("legacy response classification", () => {
  it("preserves compound-fault precedence for each profile", async () => {
    const oversized = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(1024 * 1024 + 1));
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "text/plain",
            location: "https://example.invalid/",
          },
        },
      );
    expect(
      (
        await run(
          oversized(),
          civicTenant,
          civicRecLegacyProfile,
          civicRequest(),
        )
      ).result,
    ).toMatchObject({ code: "schema_changed" });
    expect(
      (
        await run(
          oversized(),
          activeTenant,
          activeNetLegacyProfile,
          activeRequest(),
        )
      ).result,
    ).toMatchObject({ code: "access_blocked" });

    const mismatch = new Response(new Uint8Array([0xc3, 0x28]), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "3",
        location: "https://example.invalid/",
      },
    });
    expect(
      (await run(mismatch, civicTenant, civicRecLegacyProfile, civicRequest()))
        .result,
    ).toMatchObject({ code: "http_error", retryable: false });
    const malformed = new Response(new Uint8Array([0xc3, 0x28]), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": "2",
        location: "https://example.invalid/",
      },
    });
    expect(
      (await run(malformed, civicTenant, civicRecLegacyProfile, civicRequest()))
        .result,
    ).toMatchObject({ code: "schema_changed" });
    const redirected = oversized();
    Object.defineProperty(redirected, "redirected", { value: true });
    expect(
      (
        await run(
          redirected,
          civicTenant,
          civicRecLegacyProfile,
          civicRequest(),
        )
      ).result,
    ).toMatchObject({ code: "access_blocked" });
    const blocked = new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        location: "https://example.invalid/",
      },
    });
    expect(
      (await run(blocked, civicTenant, civicRecLegacyProfile, civicRequest()))
        .result,
    ).toMatchObject({ code: "access_blocked" });
  });

  it("disposes an unread rejection before releasing its gate", async () => {
    const events: string[] = [];
    const response = new Response(
      new ReadableStream({
        cancel() {
          events.push("cancel");
        },
      }),
      { status: 429, headers: { "retry-after": "23" } },
    );
    const gate: Gate = {
      acquire: async () => ({}),
      release: async (_ticket, outcome) => {
        events.push("release");
        expect(outcome).toMatchObject({
          ok: false,
          status: 429,
          error: "rate_limited",
          retryAfterMs: 23000,
        });
      },
    };
    let fetches = 0;
    const fetcher: typeof fetch = async () => {
      fetches += 1;
      return response;
    };
    const client = runtime(civicTenant, civicRecLegacyProfile, gate, fetcher, {
      monotonicNow: () => 0,
    });
    await expect(
      client.execute(() => client.http.request(civicRequest())),
    ).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 23000,
    });
    expect(events).toEqual(["cancel", "release"]);
    expect(fetches).toBe(1);
    const withLocation = new Response(null, {
      status: 429,
      headers: { "retry-after": "23", location: "https://example.invalid/" },
    });
    expect(
      (
        await run(
          withLocation,
          civicTenant,
          civicRecLegacyProfile,
          civicRequest(),
        )
      ).result,
    ).toMatchObject({ code: "access_blocked" });
  });

  it("waits for asynchronous cancellation before releasing the lease", async () => {
    let finishCancel!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      finishCancel = resolve;
    });
    const cancel = vi.fn(() => cancelled);
    const response = new Response(new ReadableStream({ cancel }), {
      status: 503,
    });
    const release = vi.fn(async () => {});
    const gate: Gate = { acquire: async () => ({}), release };
    const client = runtime(
      civicTenant,
      civicRecLegacyProfile,
      gate,
      async () => response,
    );
    const pending = client
      .execute(() => client.http.request(civicRequest()))
      .catch((error: unknown) => error);
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(release).not.toHaveBeenCalled();
    finishCancel();
    expect(await pending).toMatchObject({
      code: "http_error",
      retryable: true,
    });
    expect(release).toHaveBeenCalledOnce();
  });

  it("classifies denials and server failures without reading an error body", async () => {
    for (const [status, code, retryable] of [
      [201, "http_error", false],
      [302, "access_blocked", false],
      [401, "access_blocked", false],
      [403, "access_blocked", false],
      [400, "http_error", false],
      [503, "http_error", true],
    ] as const) {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), { status });
      const { result, fetches } = await run(
        response,
        civicTenant,
        civicRecLegacyProfile,
        civicRequest(),
      );
      expect(result).toMatchObject({ code, retryable });
      expect(cancel).toHaveBeenCalledOnce();
      expect(fetches).toBe(1);
    }
  });

  it("marks non-aborted fetch and stream timeout errors non-retryable for the any-abort profile", async () => {
    for (const kind of ["fetch", "stream", "ordinary"] as const) {
      const recording = createRecordingGate();
      const failure = new Error("example-sensitive");
      if (kind !== "ordinary") failure.name = "TimeoutError";
      const client = runtime(
        civicTenant,
        civicRecLegacyProfile,
        recording.gate,
        async () => {
          if (kind !== "stream") throw failure;
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.error(failure);
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
      );
      await expect(
        client.execute(() => client.http.request(civicRequest())),
      ).rejects.toMatchObject({ code: "http_error", retryable: false });
      expect(recording.calls).toHaveLength(2);
      expect(recording.calls.at(-1)).toEqual({
        type: "release",
        ticket: 1,
        outcome: {
          ok: false,
          ...(kind === "stream" ? { status: 200 } : {}),
          error: "http_error",
          retryAfterMs: null,
          retryable: false,
        },
      });
    }
  });

  it("marks an actual signal abort retryable for the any-abort profile", async () => {
    const recording = createRecordingGate();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const client = runtime(
      civicTenant,
      civicRecLegacyProfile,
      recording.gate,
      fetcher,
      {
        signal: controller.signal,
      },
    );
    const pending = client.execute(() => client.http.request(civicRequest()));
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: "http_error",
      retryable: true,
    });
    expect(recording.calls.at(-1)).toEqual({
      type: "release",
      ticket: 1,
      outcome: {
        ok: false,
        error: "http_error",
        retryAfterMs: null,
        retryable: true,
      },
    });
  });

  it("sanitizes transport failures and preserves only typed error controls", async () => {
    for (const [original, code, retryable, delay] of [
      [new Error("example-sensitive"), "http_error", false, null],
      [
        Object.assign(new Error("example-sensitive"), { name: "TimeoutError" }),
        "http_error",
        true,
        null,
      ],
      [
        Object.assign(new ConnectorError("rate_limited", true, 23000), {
          detail: "example-sensitive",
        }),
        "rate_limited",
        true,
        23000,
      ],
    ] as const) {
      const recording = createRecordingGate();
      const client = runtime(
        activeTenant,
        activeNetLegacyProfile,
        recording.gate,
        async () => {
          throw original;
        },
        { leaseScope: "per_read" },
      );
      const error = await client
        .execute(() => client.http.request(activeRequest()))
        .catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code, retryable, retryAfterMs: delay });
      expect(error).not.toBe(original);
      expect(JSON.stringify(error)).not.toContain("example-sensitive");
      expect(recording.calls.at(-1)).toMatchObject({
        type: "release",
        outcome: { ok: false, error: code, retryAfterMs: delay, retryable },
      });
    }
    for (const timeout of [false, true]) {
      const failure = new Error("example-sensitive");
      if (timeout) failure.name = "TimeoutError";
      const response = new Response(
        new ReadableStream({
          start(controller) {
            controller.error(failure);
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
      const { result } = await run(
        response,
        activeTenant,
        activeNetLegacyProfile,
        activeRequest(),
      );
      expect(result).toMatchObject({ code: "http_error", retryable: timeout });
      expect(JSON.stringify(result)).not.toContain("example-sensitive");
    }
  });

  it("sanitizes a per-request release failure without retrying or reacquiring", async () => {
    const raw = Object.assign(
      new Error("example-sensitive", { cause: new Error("example-sensitive") }),
      { detail: "example-sensitive" },
    );
    const timeout = Object.assign(new Error("example-sensitive"), {
      name: "TimeoutError",
      detail: "example-sensitive",
    });
    const typed = Object.assign(
      new ConnectorError("rate_limited", true, 23000),
      {
        detail: "example-sensitive",
      },
    );
    for (const [status, original, expected] of [
      [200, raw, new ConnectorError("http_error", false, null)],
      [503, timeout, new ConnectorError("http_error", false, null)],
      [200, typed, new ConnectorError("rate_limited", true, 23000)],
    ] as const) {
      const ticket = {};
      const acquire = vi.fn(async () => ticket);
      const release = vi.fn(async () => {
        throw original;
      });
      const fetcher = vi.fn<typeof fetch>(
        async () =>
          new Response("{}", {
            status,
            headers: { "content-type": "application/json" },
          }),
      );
      const client = runtime(
        civicTenant,
        civicRecLegacyProfile,
        { acquire, release },
        fetcher,
      );
      const error = await client
        .execute(() => client.http.request(civicRequest()))
        .catch((caught: unknown) => caught);
      expect(error).toEqual(expected);
      expect(error).not.toBe(original);
      expect(error).not.toHaveProperty("detail");
      expect(error).not.toHaveProperty("cause");
      expect((error as Error).message).toBe(expected.code);
      expect(JSON.stringify(error)).not.toContain("example-sensitive");
      expect(acquire).toHaveBeenCalledOnce();
      expect(fetcher).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledOnce();
      expect(release).toHaveBeenCalledWith(
        ticket,
        expect.objectContaining({ status }),
      );
    }
  });

  it("preserves a per-read release failure for the caller", async () => {
    const original = new Error("example-control");
    const acquire = vi.fn(async () => ({}));
    const release = vi.fn(async () => {
      throw original;
    });
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response("{}", { headers: { "content-type": "application/json" } }),
    );
    const client = runtime(
      activeTenant,
      activeNetLegacyProfile,
      { acquire, release },
      fetcher,
      {
        leaseScope: "per_read",
      },
    );
    await expect(
      client.execute(() => client.http.request(activeRequest())),
    ).rejects.toBe(original);
    expect(acquire).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not compare decoded content with compressed wire length", async () => {
    const response = new Response("{}", {
      headers: {
        "content-type": "application/json",
        "content-length": "9",
        "content-encoding": "gzip",
      },
    });
    const { result } = await run(
      response,
      civicTenant,
      civicRecLegacyProfile,
      civicRequest(),
    );
    expect(result).toMatchObject({ status: 200, text: "{}" });
  });

  it("rejects invalid content lengths and incomplete bodies before release", async () => {
    for (const length of ["-1", "invalid", "1048577"]) {
      const response = new Response("{}", {
        headers: {
          "content-type": "application/json",
          "content-length": length,
        },
      });
      const { result, calls } = await run(
        response,
        civicTenant,
        civicRecLegacyProfile,
        civicRequest(),
      );
      expect(result).toMatchObject({ code: "schema_changed" });
      expect(calls.at(-1)).toMatchObject({
        type: "release",
        outcome: { ok: false, error: "schema_changed" },
      });
    }
    const incomplete = new Response("{}", {
      headers: { "content-type": "application/json", "content-length": "3" },
    });
    expect(
      (
        await run(
          incomplete,
          civicTenant,
          civicRecLegacyProfile,
          civicRequest(),
        )
      ).result,
    ).toMatchObject({ code: "http_error", retryable: false });
  });

  it("accepts the body limit and keeps profile-specific challenge detection", async () => {
    const payload = JSON.stringify({ value: "x".repeat(1024 * 1024 - 12) });
    expect(Buffer.byteLength(payload)).toBe(1024 * 1024);
    const atLimit = new Response(payload, {
      headers: { "content-type": "application/json" },
    });
    expect(
      (await run(atLimit, civicTenant, civicRecLegacyProfile, civicRequest()))
        .result,
    ).toMatchObject({ status: 200 });
    const challenge = () =>
      new Response(JSON.stringify({ note: "<title>Just a moment" }), {
        headers: { "content-type": "application/json" },
      });
    expect(
      (
        await run(
          challenge(),
          civicTenant,
          civicRecLegacyProfile,
          civicRequest(),
        )
      ).result,
    ).toMatchObject({ code: "access_blocked" });
    expect(
      (
        await run(
          challenge(),
          activeTenant,
          activeNetLegacyProfile,
          activeRequest(),
        )
      ).result,
    ).toMatchObject({ status: 200 });
  });

  it("classifies payload blocks before a per-request release", async () => {
    const response = new Response('{"error":"session expired"}', {
      headers: { "content-type": "application/json" },
    });
    const { result, calls } = await run(
      response,
      civicTenant,
      civicRecLegacyProfile,
      civicRequest(),
    );
    expect(result).toMatchObject({ code: "access_blocked" });
    expect(calls.at(-1)).toEqual({
      type: "release",
      ticket: 1,
      outcome: {
        ok: false,
        status: 200,
        error: "access_blocked",
        retryAfterMs: null,
        retryable: false,
      },
    });
  });

  it("retains the legacy empty HTML success release before bootstrap parsing fails", async () => {
    const recording = createRecordingGate();
    const fetcher: typeof fetch = async () =>
      new Response(null, {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    const client = runtime(
      civicTenant,
      civicRecLegacyProfile,
      recording.gate,
      fetcher,
      { monotonicNow: () => 0 },
    );
    await expect(
      client.execute(async () =>
        bootstrapAttributes(
          (await client.http.request(bootstrapRequest())).text,
        ),
      ),
    ).rejects.toMatchObject({ code: "schema_changed" });
    expect(recording.calls.at(-1)).toEqual({
      type: "release",
      ticket: 1,
      outcome: { ok: true, status: 200 },
    });
  });

  it("releases a successful bootstrap before cookie-scope parsing fails", async () => {
    const recording = createRecordingGate();
    const headers = new Headers({ "content-type": "text/html" });
    headers.append(
      "set-cookie",
      "ExampleSession=example-token; Path=/; Domain=other.invalid; Secure",
    );
    const page =
      "{&quot;checkoutData&quot;:{&quot;user&quot;:null,&quot;key&quot;:&quot;example-session&quot;}}";
    const body = `<div data-page-data='${page}' data-base-path='/XX/example-city/'></div>`;
    const client = runtime(
      civicTenant,
      civicRecLegacyProfile,
      recording.gate,
      async () => new Response(body, { headers }),
      { monotonicNow: () => 0 },
    );
    const request = bootstrapRequest();
    await expect(
      client.execute(async () => {
        const response = await client.http.request(request);
        return parseAnonymousBootstrap({
          html: response.text,
          headers: response.headers,
          catalogUrl: request.url,
          receivedAt: response.receivedAt,
          cookieDomains: ["secure.rec1.com", "rec1.com"],
        });
      }),
    ).rejects.toMatchObject({ code: "access_blocked" });
    expect(recording.calls.at(-1)).toEqual({
      type: "release",
      ticket: 1,
      outcome: { ok: true, status: 200 },
    });
  });

  it("enforces a single 15-second deadline and disposes a late response", async () => {
    vi.useFakeTimers({ now: 0 });
    let resolveFetch!: (response: Response) => void;
    let fetches = 0;
    const fetcher: typeof fetch = () => {
      fetches += 1;
      return new Promise((resolve) => {
        resolveFetch = resolve;
      });
    };
    const recording = createRecordingGate();
    const client = runtime(
      civicTenant,
      civicRecLegacyProfile,
      recording.gate,
      fetcher,
      { monotonicNow: () => Date.now() },
    );
    const result = client
      .execute(() => client.http.request(civicRequest()))
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(14999);
    expect(recording.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await result).toMatchObject({ code: "http_error", retryable: true });
    expect(recording.calls.at(-1)).toEqual({
      type: "release",
      ticket: 1,
      outcome: {
        ok: false,
        error: "http_error",
        retryAfterMs: null,
        retryable: true,
      },
    });
    const cancel = vi.fn();
    resolveFetch(new Response(new ReadableStream({ cancel })));
    await Promise.resolve();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetches).toBe(1);
  });

  it("times out a stalled body and cancels it before gate release", async () => {
    vi.useFakeTimers({ now: 0 });
    const events: string[] = [];
    const response = new Response(
      new ReadableStream({
        cancel() {
          events.push("cancel");
        },
      }),
      { headers: { "content-type": "application/json" } },
    );
    const gate: Gate = {
      acquire: async () => ({}),
      release: async (_ticket, outcome) => {
        events.push("release");
        expect(outcome).toMatchObject({ error: "http_error" });
      },
    };
    const fetcher: typeof fetch = async () => response;
    const client = runtime(civicTenant, civicRecLegacyProfile, gate, fetcher, {
      monotonicNow: () => Date.now(),
    });
    const result = client
      .execute(() => client.http.request(civicRequest()))
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await result).toMatchObject({ code: "http_error", retryable: true });
    expect(events).toEqual(["cancel", "release"]);
    expect(response.body?.locked).toBe(false);
  });

  it("shares the deadline between delayed headers and a stalled body", async () => {
    vi.useFakeTimers({ now: 0 });
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-type": "application/json" },
    });
    const recording = createRecordingGate();
    const client = runtime(
      civicTenant,
      civicRecLegacyProfile,
      recording.gate,
      () =>
        new Promise((resolve) => setTimeout(() => resolve(response), 14000)),
      { monotonicNow: () => Date.now() },
    );
    const result = client
      .execute(() => client.http.request(civicRequest()))
      .catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(14000);
    expect(recording.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toMatchObject({ code: "http_error", retryable: true });
    expect(cancel).toHaveBeenCalledOnce();
    expect(recording.calls.at(-1)).toMatchObject({
      type: "release",
      outcome: { ok: false, error: "http_error" },
    });
  });

  it("enforces the monotonic deadline even before the timer callback runs", async () => {
    vi.useFakeTimers({ now: 0 });
    let reads = 0;
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), {
      headers: { "content-type": "application/json" },
    });
    const recording = createRecordingGate();
    const client = runtime(
      civicTenant,
      civicRecLegacyProfile,
      recording.gate,
      async () => response,
      { monotonicNow: () => (++reads >= 3 ? 15000 : 0) },
    );
    const result = await client
      .execute(() => client.http.request(civicRequest()))
      .catch((error: unknown) => error);
    expect(result).toMatchObject({ code: "http_error", retryable: true });
    expect(cancel).toHaveBeenCalledOnce();
    expect(recording.calls.at(-1)).toMatchObject({
      type: "release",
      outcome: { ok: false, error: "http_error" },
    });
  });

  it("preserves the profiles' different external-abort retry rules", async () => {
    for (const [tenant, profile, request, retryable] of [
      [activeTenant, activeNetLegacyProfile, activeRequest(), false],
      [civicTenant, civicRecLegacyProfile, civicRequest(), true],
    ] as const) {
      const controller = new AbortController();
      const recording = createRecordingGate();
      const fetcher: typeof fetch = () => new Promise(() => {});
      const client = runtime(tenant, profile, recording.gate, fetcher, {
        signal: controller.signal,
      });
      const result = client
        .execute(() => client.http.request(request))
        .catch((error: unknown) => error);
      await Promise.resolve();
      controller.abort();
      expect(await result).toMatchObject({ code: "http_error", retryable });
    }
  });
});
