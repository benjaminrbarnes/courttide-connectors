import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSessionStore,
  GateDeferred,
  type Gate,
  type SessionStore,
} from "../packages/connectors/src/index.js";
import { civicRecPlatform } from "../packages/connectors/src/platforms/civicrec/index.js";
import {
  clock,
  deferred,
  freezeClock,
  job,
  range,
  response,
  tenant,
  transport,
} from "./support/civicrec-session.js";

afterEach(() => vi.useRealTimers());

describe("scoped anonymous bootstrap sessions", () => {
  it("reuses one proof across six independent two-date jobs with separate gates", async () => {
    freezeClock();
    const config = structuredClone(tenant);
    const original = config.parks[0]!.courts[0]!;
    for (let key = 900006; key <= 900010; key += 1) {
      const court = structuredClone(original);
      court.key = String(key);
      (court.params as Record<string, unknown>).facilityId = key;
      config.parks[0]!.courts.push(court);
    }
    const store = createSessionStore({ maxAgeMs: 60_000 });
    const upstream = transport();
    const jobs = config.parks[0]!.courts.map((court) =>
      job({ store, fetcher: upstream.fetcher, config, court: court.key }),
    );
    for (const current of jobs) {
      const reading = await current.read();
      expect(reading.days).toHaveLength(2);
      expect(JSON.stringify(reading)).not.toMatch(
        /example-session|example-token/,
      );
    }
    expect(upstream.requests).toHaveLength(13);
    expect(upstream.requests.filter((item) => item.bootstrap)).toEqual([
      { bootstrap: true, cookie: null },
    ]);
    expect(upstream.requests.filter((item) => !item.bootstrap)).toHaveLength(
      12,
    );
    expect(
      upstream.requests
        .filter((item) => !item.bootstrap)
        .every((item) => item.cookie === "ExampleSession=example-token"),
    ).toBe(true);
    expect(jobs.map((current) => current.recording.calls.length)).toEqual([
      6, 4, 4, 4, 4, 4,
    ]);
  });

  it("single-flights a successful bootstrap across fresh runtimes", async () => {
    freezeClock();
    const pending = deferred<Response>();
    const upstream = transport({ bootstrap: () => pending.promise });
    const store = createSessionStore({ maxAgeMs: 60_000 });
    const first = job({ store, fetcher: upstream.fetcher });
    const second = job({ store, fetcher: upstream.fetcher });
    const reads = Promise.all([first.read(), second.read()]);
    await vi.waitFor(() => expect(upstream.requests).toHaveLength(1));
    pending.resolve(response());
    const readings = await reads;
    expect(readings).toHaveLength(2);
    expect(JSON.stringify(readings[0])).toBe(JSON.stringify(readings[1]));
    expect(upstream.requests).toHaveLength(5);
    expect(first.recording.calls).toHaveLength(6);
    expect(second.recording.calls).toHaveLength(4);
  });

  it("expires at the earliest included cookie or the shorter local policy", async () => {
    freezeClock();
    const upstream = transport({
      bootstrap: () =>
        response("ExampleSession=example-token; Path=/; Secure; Max-Age=5"),
    });
    const store = createSessionStore({ maxAgeMs: 60_000 });
    const make = () => job({ store, fetcher: upstream.fetcher });
    await make().read();
    vi.setSystemTime(new Date("2026-11-04T12:00:04.000Z"));
    await make().read();
    vi.setSystemTime(new Date("2026-11-04T12:00:05.000Z"));
    await make().read();
    expect(upstream.requests.filter((item) => item.bootstrap)).toHaveLength(2);

    const local = createSessionStore({ maxAgeMs: 2_000 });
    await job({ store: local, fetcher: upstream.fetcher }).read();
    vi.setSystemTime(new Date("2026-11-04T12:00:07.000Z"));
    await job({ store: local, fetcher: upstream.fetcher }).read();
    expect(upstream.requests.filter((item) => item.bootstrap)).toHaveLength(4);
  });

  it("rejects a bootstrap that expires before either waiting job can adopt its proof", async () => {
    freezeClock();
    const upstream = transport({
      bootstrap: () =>
        response("ExampleSession=example-token; Path=/; Secure; Max-Age=5"),
    });
    const store = createSessionStore({ maxAgeMs: 60_000 });
    const holding = deferred<void>();
    const entered = deferred<void>();
    const release = vi.fn<Gate["release"]>(async () => {
      entered.resolve();
      await holding.promise;
    });
    const gate: Gate = { acquire: async () => ({}), release };
    const first = job({ store, fetcher: upstream.fetcher, gate });
    const second = job({ store, fetcher: upstream.fetcher });
    const results = Promise.allSettled([first.read(), second.read()]);
    await entered.promise;
    vi.setSystemTime(new Date("2026-11-04T12:00:05.000Z"));
    holding.resolve();
    for (const result of await results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({ code: "schema_changed" });
    }
    expect(upstream.requests).toHaveLength(1);
    expect(release).toHaveBeenCalledOnce();
    expect(release.mock.calls[0]?.[1]).toEqual({ ok: true, status: 200 });
    expect(second.recording.calls).toEqual([]);
  });

  it("renews known expiry between dates with a separately admitted bootstrap", async () => {
    freezeClock();
    const upstream = transport({
      bootstrap: () =>
        response("ExampleSession=example-token; Path=/; Secure; Max-Age=5"),
      calendar: (count) => {
        if (count === 1) vi.setSystemTime(new Date("2026-11-04T12:00:05.000Z"));
        return new Response(
          JSON.stringify({
            hours: [],
            displayHours: [],
            availableForRate: true,
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const current = job({
      store: createSessionStore({ maxAgeMs: 60_000 }),
      fetcher: upstream.fetcher,
    });
    await current.read();
    expect(upstream.requests.map((item) => item.bootstrap)).toEqual([
      true,
      false,
      true,
      false,
    ]);
    expect(current.recording.calls).toHaveLength(8);
  });

  it("does not send a cookie when its proof expires while waiting on the job gate", async () => {
    freezeClock();
    const upstream = transport({
      bootstrap: () =>
        response("ExampleSession=example-token; Path=/; Secure; Max-Age=5"),
    });
    const store = createSessionStore({ maxAgeMs: 60_000 });
    await job({ store, fetcher: upstream.fetcher }).read();
    const holding = deferred<void>();
    const entered = deferred<void>();
    const release = vi.fn<Gate["release"]>(async () => {});
    const gate: Gate = {
      acquire: async () => {
        entered.resolve();
        await holding.promise;
        return {};
      },
      release,
    };
    const warm = job({ store, fetcher: upstream.fetcher, gate });
    const result = warm.read();
    await entered.promise;
    vi.setSystemTime(new Date("2026-11-04T12:00:05.000Z"));
    holding.resolve();
    await expect(result).rejects.toMatchObject({ code: "schema_changed" });
    expect(upstream.requests).toHaveLength(3);
    expect(release).toHaveBeenCalledOnce();
    expect(release.mock.calls[0]?.[1]).toMatchObject({
      ok: false,
      error: "schema_changed",
    });
  });

  it("invalidates a blocked calendar session without retrying that read", async () => {
    freezeClock();
    const upstream = transport({
      bootstrap: (count) =>
        count === 1 ? new Response("", { status: 403 }) : response(),
      calendar: (count) =>
        count === 1
          ? new Response("", { status: 403 })
          : new Response(
              JSON.stringify({
                hours: [],
                displayHours: [],
                availableForRate: true,
              }),
              { headers: { "content-type": "application/json" } },
            ),
    });
    const store = createSessionStore({ maxAgeMs: 60_000 });
    const make = () => job({ store, fetcher: upstream.fetcher });
    await expect(make().read()).rejects.toMatchObject({
      code: "access_blocked",
    });
    expect(upstream.requests).toHaveLength(1);
    await expect(make().read()).rejects.toMatchObject({
      code: "access_blocked",
    });
    expect(upstream.requests).toHaveLength(3);
    await make().read();
    expect(upstream.requests.filter((item) => item.bootstrap)).toHaveLength(3);
    expect(upstream.requests).toHaveLength(6);
  });

  it("invalidates a session rejected by the payload classifier for the next job", async () => {
    freezeClock();
    let rejectCurrentSession = false;
    const upstream = transport({
      calendar: (count) =>
        rejectCurrentSession && count === 3
          ? new Response(JSON.stringify({ error: "session expired" }), {
              headers: { "content-type": "application/json" },
            })
          : new Response(
              JSON.stringify({
                hours: [],
                displayHours: [],
                availableForRate: true,
              }),
              { headers: { "content-type": "application/json" } },
            ),
    });
    const store = createSessionStore({ maxAgeMs: 60_000 });
    const make = () => job({ store, fetcher: upstream.fetcher });
    await make().read();
    expect(upstream.requests.filter((item) => item.bootstrap)).toHaveLength(1);

    rejectCurrentSession = true;
    const rejected = make();
    await expect(rejected.read()).rejects.toMatchObject({
      code: "access_blocked",
    });
    expect(upstream.requests).toHaveLength(4);
    expect(rejected.recording.calls.at(-1)).toMatchObject({
      outcome: { ok: false, error: "access_blocked", status: 200 },
    });

    rejectCurrentSession = false;
    await make().read();
    expect(upstream.requests.map((item) => item.bootstrap)).toEqual([
      true,
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
  });

  it.each([
    [429, "rate_limited"],
    [503, "http_error"],
    [200, "schema_changed"],
  ] as const)(
    "does not cache failed bootstrap status %s",
    async (status, code) => {
      freezeClock();
      const upstream = transport({
        bootstrap: (count) =>
          count === 1
            ? new Response("", {
                status,
                headers: { "content-type": "text/html" },
              })
            : response(),
      });
      const store = createSessionStore({ maxAgeMs: 60_000 });
      await expect(
        job({ store, fetcher: upstream.fetcher }).read(),
      ).rejects.toMatchObject({ code });
      expect(upstream.requests).toHaveLength(1);
      await job({ store, fetcher: upstream.fetcher }).read();
      expect(upstream.requests).toHaveLength(4);
    },
  );

  it("passes through admission deferral without a release or cached failure", async () => {
    freezeClock();
    const upstream = transport();
    const store = createSessionStore({ maxAgeMs: 60_000 });
    const deferredGate = new GateDeferred("2026-11-04T12:00:05Z", "pacing");
    const release = vi.fn<Gate["release"]>(async () => {});
    const gate: Gate = {
      acquire: async () => {
        throw deferredGate;
      },
      release,
    };
    await expect(
      job({ store, fetcher: upstream.fetcher, gate }).read(),
    ).rejects.toBe(deferredGate);
    expect(upstream.requests).toEqual([]);
    expect(release).not.toHaveBeenCalled();
    await job({ store, fetcher: upstream.fetcher }).read();
    expect(upstream.requests).toHaveLength(3);
  });

  it("cancels a waiter without cancelling the bootstrap owner or making its own read", async () => {
    freezeClock();
    const pending = deferred<Response>();
    const upstream = transport({ bootstrap: () => pending.promise });
    const store = createSessionStore({ maxAgeMs: 60_000 });
    const owner = job({ store, fetcher: upstream.fetcher });
    const cancellation = new AbortController();
    const waiter = job({
      store,
      fetcher: upstream.fetcher,
      signal: cancellation.signal,
    });
    const ownerRead = owner.read();
    const waiterRead = waiter.read();
    await vi.waitFor(() => expect(upstream.requests).toHaveLength(1));
    cancellation.abort();
    await expect(waiterRead).rejects.toMatchObject({
      code: "http_error",
      retryable: true,
    });
    expect(waiter.recording.calls).toEqual([]);
    pending.resolve(response());
    await ownerRead;
    expect(upstream.requests).toHaveLength(3);
    expect(owner.recording.calls).toHaveLength(6);
  });

  it("fails coalesced jobs on owner cancellation and starts again only on explicit invocation", async () => {
    freezeClock();
    const pending = deferred<Response>();
    const upstream = transport({
      bootstrap: (count) => (count === 1 ? pending.promise : response()),
    });
    const store = createSessionStore({ maxAgeMs: 60_000 });
    const cancellation = new AbortController();
    const owner = job({
      store,
      fetcher: upstream.fetcher,
      signal: cancellation.signal,
    });
    const waiter = job({ store, fetcher: upstream.fetcher });
    const results = Promise.allSettled([owner.read(), waiter.read()]);
    await vi.waitFor(() => expect(upstream.requests).toHaveLength(1));
    cancellation.abort();
    for (const result of await results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected")
        expect(result.reason).toMatchObject({
          code: "http_error",
          retryable: true,
        });
    }
    expect(upstream.requests).toHaveLength(1);
    expect(owner.recording.calls).toHaveLength(2);
    expect(waiter.recording.calls).toEqual([]);
    pending.resolve(response());
    await job({ store, fetcher: upstream.fetcher }).read();
    expect(upstream.requests).toHaveLength(4);
    expect(upstream.requests.filter((item) => item.bootstrap)).toHaveLength(2);
  });

  it("isolates tenant configuration, transport identity and transport callbacks", async () => {
    freezeClock();
    const upstream = transport();
    const store = createSessionStore({ maxAgeMs: 60_000 });
    const token = {};
    const otherToken = {};
    const callback = () => undefined;
    const profile = {
      ...civicRecPlatform.transport,
      classifyTransportError: callback,
    };
    const different = { ...profile, classifyTransportError: () => undefined };
    const config = structuredClone(tenant);
    (config.params as Record<string, unknown>).locationId = 900007;
    const wrapper =
      (): typeof fetch =>
      (...args) =>
        upstream.fetcher(...args);
    await job({ store, fetcher: wrapper(), identity: token, profile }).read();
    await job({ store, fetcher: wrapper(), identity: token, profile }).read();
    await job({
      store,
      fetcher: wrapper(),
      identity: token,
      profile,
      config,
    }).read();
    await job({
      store,
      fetcher: wrapper(),
      identity: token,
      profile: different,
    }).read();
    await job({
      store,
      fetcher: wrapper(),
      identity: otherToken,
      profile,
    }).read();
    expect(upstream.requests.filter((item) => item.bootstrap)).toHaveLength(4);

    const noToken = createSessionStore({ maxAgeMs: 60_000 });
    await job({ store: noToken, fetcher: wrapper(), profile }).read();
    await job({ store: noToken, fetcher: wrapper(), profile }).read();
    expect(upstream.requests.filter((item) => item.bootstrap)).toHaveLength(6);
  });

  it("invalidates ready and in-flight entries without letting old proofs revive", async () => {
    freezeClock();
    const pending = deferred<Response>();
    const upstream = transport({
      bootstrap: (count) => (count === 1 ? pending.promise : response()),
    });
    const store = createSessionStore({ maxAgeMs: 60_000 });
    const first = job({ store, fetcher: upstream.fetcher });
    const oldRead = first.read();
    await vi.waitFor(() => expect(upstream.requests).toHaveLength(1));
    store.clear();
    const next = job({ store, fetcher: upstream.fetcher });
    await next.read();
    pending.resolve(response());
    await expect(oldRead).rejects.toMatchObject({ code: "schema_changed" });
    expect(upstream.requests).toHaveLength(4);
    next.runtime.invalidateSession();
    await job({ store, fetcher: upstream.fetcher }).read();
    expect(upstream.requests.filter((item) => item.bootstrap)).toHaveLength(3);
  });

  it("rejects forged stores and cookies before admission and after invalidation", async () => {
    freezeClock();
    const upstream = transport();
    expect(() =>
      job({
        store: { clear() {} } as SessionStore,
        fetcher: upstream.fetcher,
      }),
    ).toThrowError(expect.objectContaining({ code: "schema_changed" }));
    const store = createSessionStore({ maxAgeMs: 60_000 });
    expect(JSON.stringify(store)).toBe("{}");
    const current = job({ store, fetcher: upstream.fetcher });
    const request = {
      court: "900003",
      purpose: "calendar" as const,
      method: "GET" as const,
      url: new URL(
        "/XX/example-city/catalog/getFacilityHours/example-session/900003/900004/2026-11-04",
        tenant.origin,
      ),
      headers: {
        accept: "application/json",
        "x-requested-with": "XMLHttpRequest",
        cookie: "ExampleSession=example-forged",
      },
      expect: "json" as const,
    };
    await expect(current.runtime.http.request(request)).rejects.toMatchObject({
      code: "schema_changed",
    });
    expect(current.recording.calls).toEqual([]);
    await current.read();
    const count = current.recording.calls.length;
    await expect(current.runtime.http.request(request)).rejects.toMatchObject({
      code: "schema_changed",
    });
    store.clear();
    request.headers.cookie = "ExampleSession=example-token";
    await expect(current.runtime.http.request(request)).rejects.toMatchObject({
      code: "schema_changed",
    });
    expect(current.recording.calls).toHaveLength(count);
    expect(upstream.requests).toHaveLength(3);
  });

  it("requires the selected connector and runtime to agree on tenant and cancellation authority", async () => {
    freezeClock();
    const upstream = transport();
    const store = createSessionStore({ maxAgeMs: 60_000 });
    const current = job({ store, fetcher: upstream.fetcher });
    const changed = structuredClone(tenant);
    (changed.params as Record<string, unknown>).locationId = 900007;
    const differentTenant = civicRecPlatform.createConnector({
      tenant: changed,
      http: current.runtime.http,
      now: clock,
    });
    const differentSignal = civicRecPlatform.createConnector({
      tenant,
      http: current.runtime.http,
      now: clock,
      signal: new AbortController().signal,
    });
    for (const connector of [differentTenant, differentSignal]) {
      await expect(connector.readCourt("900003", range)).rejects.toMatchObject({
        code: "schema_changed",
      });
    }
    expect(current.recording.calls).toEqual([]);
    expect(upstream.requests).toEqual([]);
  });
});
