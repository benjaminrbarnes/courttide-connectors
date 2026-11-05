import { afterEach, describe, expect, it, vi } from "vitest";
import { politeGate } from "../packages/connectors/src/index.js";
import { createCliGate } from "../packages/connectors/src/cli/read.js";

const request = {
  court: "900001",
  purpose: "calendar",
  method: "GET",
  url: "https://example.invalid/",
} as const;
afterEach(() => vi.useRealTimers());

describe("shared development gate", () => {
  it("serializes requests and applies the default 2.5-second gap after release", async () => {
    vi.useFakeTimers({ now: 0 });
    const gate = politeGate({ monotonicNow: () => Date.now() });
    const first = await gate.acquire(request);
    let admitted = false;
    const second = gate.acquire(request).then((ticket) => {
      admitted = true;
      return ticket;
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(admitted).toBe(false);
    await gate.release(first, { ok: true });
    await vi.advanceTimersByTimeAsync(2_499);
    expect(admitted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(admitted).toBe(true);
    await gate.release(await second, { ok: true });
  });

  it("accepts an explicit two-second minimum and rejects smaller or invalid values", async () => {
    vi.useFakeTimers({ now: 0 });
    const gate = politeGate({
      minimumGapMs: 2_000,
      monotonicNow: () => Date.now(),
    });
    await gate.release(await gate.acquire(request), { ok: true });
    let admitted = false;
    const next = gate.acquire(request).then((ticket) => {
      admitted = true;
      return ticket;
    });
    await vi.advanceTimersByTimeAsync(1_999);
    expect(admitted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(admitted).toBe(true);
    await gate.release(await next, { ok: true });
    for (const minimumGapMs of [1_999, NaN, Infinity])
      expect(() => politeGate({ minimumGapMs })).toThrow(RangeError);
  });

  it("does not retain the superseded rolling windows", async () => {
    vi.useFakeTimers({ now: 0 });
    const gate = politeGate({ monotonicNow: () => Date.now() });
    for (let index = 0; index < 32; index += 1) {
      if (index) await vi.advanceTimersByTimeAsync(2_500);
      await gate.release(await gate.acquire(request), { ok: true });
    }
    expect(Date.now()).toBe(77_500);
  });

  it.each([
    [{ ok: false, error: "http_error", status: 503 }, 60_000],
    [
      { ok: false, error: "rate_limited", status: 429, retryAfterMs: 90_000 },
      90_000,
    ],
    [
      { ok: false, error: "http_error", status: 503, retryAfterMs: 120_000 },
      120_000,
    ],
  ] as const)(
    "defers failed work and honors a supplied longer delay",
    async (outcome, delay) => {
      vi.useFakeTimers({ now: 0 });
      const gate = politeGate({
        monotonicNow: () => Date.now(),
        wallNow: () => new Date(Date.now()),
      });
      const first = await gate.acquire(request);
      const queued = expect(gate.acquire(request)).rejects.toMatchObject({
        name: "GateDeferred",
        until: new Date(delay).toISOString(),
      });
      await gate.release(first, outcome);
      await queued;
      await expect(gate.acquire(request)).rejects.toMatchObject({
        name: "GateDeferred",
      });
      await vi.advanceTimersByTimeAsync(delay);
      await gate.release(await gate.acquire(request), { ok: true });
    },
  );

  it("does not back off on success and permanently stops on a block", async () => {
    vi.useFakeTimers({ now: 0 });
    const gate = politeGate({ monotonicNow: () => Date.now() });
    await gate.release(await gate.acquire(request), {
      ok: true,
      status: 200,
      retryAfterMs: 120_000,
    });
    const second = gate.acquire(request);
    await vi.advanceTimersByTimeAsync(2_500);
    const ticket = await second;
    const queued = expect(gate.acquire(request)).rejects.toMatchObject({
      code: "access_blocked",
    });
    await gate.release(ticket, { ok: false, status: 403, error: "http_error" });
    await queued;
    await expect(gate.acquire(request)).rejects.toMatchObject({
      code: "access_blocked",
    });
  });

  it("shares each origin across courts while keeping different sites independent", async () => {
    vi.useFakeTimers({
      now: 0,
      toFake: ["Date", "performance", "setTimeout", "clearTimeout"],
    });
    const execution = createCliGate(
      2_500,
      new Map([["https://example.invalid", 4_000]]),
    );
    const first = await execution.gate.acquire(request);
    let sameSiteAdmitted = false;
    const sameSite = execution.gate
      .acquire({
        ...request,
        court: "900002",
        url: "https://example.invalid/example-other",
      })
      .then((ticket) => {
        sameSiteAdmitted = true;
        return ticket;
      });
    const other = await execution.gate.acquire({
      ...request,
      url: "https://other.example.invalid/",
    });
    expect(sameSiteAdmitted).toBe(false);
    await execution.gate.release(first, { ok: true });
    await vi.advanceTimersByTimeAsync(3_999);
    expect(sameSiteAdmitted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(sameSiteAdmitted).toBe(true);
    await execution.gate.release(await sameSite, { ok: true });
    await execution.gate.release(other, { ok: true });
  });
});
