import { afterEach, expect, it, vi } from "vitest";
import {
  AdmissionError,
  createHttpAdmissionGate,
  createSessionStore,
} from "../packages/connectors/src/index.js";
import type { Gate } from "../packages/connectors/src/index.js";
import { createRecordingGate } from "../packages/connectors/src/testing/index.js";
import {
  freezeClock,
  job,
  tenant,
  transport,
} from "./support/civicrec-session.js";

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
function admissionService() {
  const bodies: unknown[] = [];
  let count = 0;
  const serviceFetch = vi.fn<typeof fetch>(async (input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (!String(input).endsWith("/reserve")) return json({ recorded: true });
    const suffix = String(++count).padStart(12, "0");
    return json({
      result: "reserved",
      reservationId: `00000000-0000-4000-8000-${suffix}`,
      allowanceOwner: "00000000-0000-4000-8000-000000000099",
      budgetDate: "2026-11-04",
      used: count,
      cap: 100,
      warningCrossed: false,
    });
  });
  function createGate(localGate: Gate) {
    return createHttpAdmissionGate({
      reserveUrl: "https://example.invalid/reserve",
      outcomeUrlTemplate: "https://example.invalid/{reservationId}/outcome",
      sourceOrigin: tenant.origin,
      bearer: "synthetic-bearer",
      localGate,
      serviceFetch,
    });
  }
  return { bodies, createGate, serviceFetch };
}
afterEach(() => vi.useRealTimers());

it("reuses a legitimate session through fresh jobs and independently admitted requests", async () => {
  freezeClock();
  const upstream = transport();
  const store = createSessionStore({ maxAgeMs: 60_000 });
  const admission = admissionService();
  const firstLocal = createRecordingGate();
  const secondLocal = createRecordingGate();
  const first = job({
    store,
    fetcher: upstream.fetcher,
    gate: admission.createGate(firstLocal.gate),
  });
  const second = job({
    store,
    fetcher: upstream.fetcher,
    gate: admission.createGate(secondLocal.gate),
  });
  await first.read();
  await second.read();
  expect(upstream.requests.map((request) => request.bootstrap)).toEqual([
    true,
    false,
    false,
    false,
    false,
  ]);
  expect(firstLocal.calls).toHaveLength(6);
  expect(secondLocal.calls).toHaveLength(4);
  expect(admission.bodies.filter((_, index) => index % 2 === 0)).toEqual([
    { purpose: "bootstrap" },
    { purpose: "calendar" },
    { purpose: "calendar" },
    { purpose: "calendar" },
    { purpose: "calendar" },
  ]);
  expect(admission.bodies.filter((_, index) => index % 2 === 1)).toEqual(
    Array.from({ length: 5 }, () => ({ result: "success", status: 200 })),
  );
  expect(JSON.stringify(admission.bodies)).not.toContain("example-token");
  expect(JSON.stringify(admission.bodies)).not.toContain("synthetic-bearer");
});

it("rechecks session expiry at the guarded send and reports a proven pre-fetch exit", async () => {
  freezeClock();
  const upstream = transport();
  const store = createSessionStore({ maxAgeMs: 5_000 });
  const admission = admissionService();
  await job({
    store,
    fetcher: upstream.fetcher,
    gate: admission.createGate(createRecordingGate().gate),
  }).read();
  const local = createRecordingGate();
  const guarded = admission.createGate(local.gate);
  const gate: Gate = {
    acquire(request, dispatch) {
      if (dispatch !== gate.dispatch) throw new AdmissionError("unavailable");
      return guarded.acquire(request, guarded.dispatch);
    },
    dispatch(ticket, request, send) {
      vi.setSystemTime(new Date("2026-11-04T12:00:05.000Z"));
      return guarded.dispatch!(ticket, request, send);
    },
    release(ticket, outcome) {
      return guarded.release(ticket, outcome);
    },
  };
  const warm = job({ store, fetcher: upstream.fetcher, gate });
  await expect(warm.read()).rejects.toMatchObject({ code: "schema_changed" });
  expect(upstream.requests).toHaveLength(3);
  expect(admission.bodies.slice(-2)).toEqual([
    { purpose: "calendar" },
    { result: "not_sent" },
  ]);
  expect(local.calls.at(-1)).toMatchObject({
    outcome: { ok: false, error: "schema_changed" },
  });
});
