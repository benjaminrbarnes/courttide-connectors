import { afterEach, expect, it, vi } from "vitest";
import {
  createSessionStore,
  type Gate,
} from "../packages/connectors/src/index.js";
import {
  freezeClock,
  deferred,
  job,
  response,
  tenant,
  transport,
} from "./support/civicrec-session.js";

afterEach(() => vi.useRealTimers());

it("uses the earliest live cookie expiry and gives Max-Age precedence", async () => {
  freezeClock();
  const upstream = transport({
    bootstrap: async () => {
      const initial = response(
        "ExampleSession=example-token; Path=/; Secure; Max-Age=10; Expires=Tue, 03 Nov 2026 12:00:00 GMT",
      );
      const headers = new Headers(initial.headers);
      headers.append(
        "set-cookie",
        "ExampleOther=example-value; Path=/; Secure; Max-Age=3",
      );
      headers.append(
        "set-cookie",
        "ExampleDeleted=example-deleted; Path=/; Secure; Max-Age=0",
      );
      return new Response(await initial.text(), { headers });
    },
  });
  const store = createSessionStore({ maxAgeMs: 60_000 });
  const make = () => job({ store, fetcher: upstream.fetcher });
  await make().read();
  expect(upstream.requests[1]?.cookie).toBe(
    "ExampleSession=example-token; ExampleOther=example-value",
  );
  vi.setSystemTime(new Date("2026-11-04T12:00:02.000Z"));
  await make().read();
  vi.setSystemTime(new Date("2026-11-04T12:00:03.000Z"));
  await make().read();
  expect(upstream.requests.filter((item) => item.bootstrap)).toHaveLength(2);
});

it("discards cached state when the local wall clock moves backward", async () => {
  freezeClock();
  const upstream = transport();
  const store = createSessionStore({ maxAgeMs: 60_000 });
  await job({ store, fetcher: upstream.fetcher }).read();
  vi.setSystemTime(new Date("2026-11-04T11:59:59.000Z"));
  await job({ store, fetcher: upstream.fetcher }).read();
  expect(upstream.requests.filter((item) => item.bootstrap)).toHaveLength(2);
});

it("rejects a mutated tenant configuration before admission", async () => {
  freezeClock();
  const upstream = transport();
  const config = structuredClone(tenant);
  const store = createSessionStore({ maxAgeMs: 60_000 });
  const current = job({ store, fetcher: upstream.fetcher, config });
  (config.params as Record<string, unknown>).locationId = 900007;
  await expect(current.read()).rejects.toMatchObject({
    code: "schema_changed",
  });
  expect(upstream.requests).toEqual([]);
  expect(current.recording.calls).toEqual([]);
});

it("awaits the cancelled bootstrap owner's pending admission and release", async () => {
  freezeClock();
  const upstream = transport();
  const store = createSessionStore({ maxAgeMs: 60_000 });
  const controller = new AbortController();
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
  const owner = job({
    store,
    fetcher: upstream.fetcher,
    gate,
    signal: controller.signal,
  });
  let settled = false;
  const result = owner.read().finally(() => {
    settled = true;
  });
  await entered.promise;
  controller.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(upstream.requests).toEqual([]);
  holding.resolve();
  await expect(result).rejects.toMatchObject({
    code: "http_error",
    retryable: true,
  });
  expect(release).toHaveBeenCalledOnce();
  expect(upstream.requests).toEqual([]);
});
