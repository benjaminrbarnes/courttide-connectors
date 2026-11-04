import { afterEach, describe, expect, it, vi } from "vitest";
import { politeGate } from "../packages/connectors/src/index.js";

const request = {
  court: "900001",
  purpose: "calendar",
  method: "GET",
  url: "https://example.invalid/",
} as const;
afterEach(() => vi.useRealTimers());

describe("shared development gate", () => {
  it("enforces all rolling ceilings across sequential requests", async () => {
    vi.useFakeTimers({ now: 0 });
    const gate = politeGate({
      minimumGapMs: 10000,
      monotonicNow: () => Date.now(),
      wallNow: () => new Date(Date.now()),
    });
    for (let index = 0; index < 20; index += 1) {
      if (index) await vi.advanceTimersByTimeAsync(10000);
      const ticket = await gate.acquire(request);
      await gate.release(ticket, { ok: true });
    }
    let released = false;
    const next = gate.acquire(request).then((ticket) => {
      released = true;
      return ticket;
    });
    await vi.advanceTimersByTimeAsync(409999);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await gate.release(await next, { ok: true });
    for (let index = 0; index < 9; index += 1) {
      await vi.advanceTimersByTimeAsync(10000);
      await gate.release(await gate.acquire(request), { ok: true });
    }
    released = false;
    const later = gate.acquire(request).then((ticket) => {
      released = true;
      return ticket;
    });
    await vi.advanceTimersByTimeAsync(2909999);
    expect(released).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await gate.release(await later, { ok: true });
  });

  it("allows one request in flight and measures the gap after release", async () => {
    vi.useFakeTimers({ now: 0 });
    const gate = politeGate({
      minimumGapMs: 10000,
      monotonicNow: () => Date.now(),
    });
    const first = await gate.acquire(request);
    let admitted = false;
    const second = gate.acquire(request).then((ticket) => {
      admitted = true;
      return ticket;
    });
    await vi.advanceTimersByTimeAsync(60000);
    expect(admitted).toBe(false);
    await gate.release(first, { ok: true });
    await vi.advanceTimersByTimeAsync(9999);
    expect(admitted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await gate.release(await second, { ok: true });
  });

  it("stops queued work on blocks and rate limits, honoring backoff", async () => {
    vi.useFakeTimers({ now: 0 });
    const gate = politeGate({
      minimumGapMs: 10000,
      monotonicNow: () => Date.now(),
      wallNow: () => new Date(Date.now()),
    });
    const first = await gate.acquire(request);
    const pending = expect(gate.acquire(request)).rejects.toMatchObject({
      name: "GateDeferred",
      until: "1970-01-01T00:01:30.000Z",
    });
    await gate.release(first, {
      ok: false,
      error: "rate_limited",
      retryAfterMs: 90000,
    });
    await pending;
    await expect(gate.acquire(request)).rejects.toMatchObject({
      name: "GateDeferred",
    });
    await vi.advanceTimersByTimeAsync(90000);
    const second = await gate.acquire(request);
    const blocked = expect(gate.acquire(request)).rejects.toMatchObject({
      code: "access_blocked",
    });
    await gate.release(second, { ok: false, error: "access_blocked" });
    await blocked;
    await expect(gate.acquire(request)).rejects.toMatchObject({
      code: "access_blocked",
    });
    expect(() => politeGate({ minimumGapMs: 9999 })).toThrow(RangeError);
  });
});
