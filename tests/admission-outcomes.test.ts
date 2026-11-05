import { expect, it, vi } from "vitest";
import {
  AdmissionError,
  createHttpAdmissionGate,
} from "../packages/connectors/src/index.js";
import type {
  Gate,
  GateOutcome,
  GateRequest,
} from "../packages/connectors/src/index.js";

const request: GateRequest = {
  court: "900001",
  purpose: "calendar",
  method: "GET",
  url: "https://example.invalid/calendar",
};
function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
function setup() {
  const bodies: unknown[] = [];
  const serviceFetch = vi.fn<typeof fetch>(async (input, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return String(input).endsWith("/reserve")
      ? json({
          result: "reserved",
          reservationId: "00000000-0000-4000-8000-000000000001",
          allowanceOwner: "00000000-0000-4000-8000-000000000002",
          budgetDate: "2026-11-04",
          used: 1,
          cap: 10,
          warningCrossed: false,
        })
      : json({ recorded: true });
  });
  const release = vi.fn<Gate["release"]>(async () => {});
  const gate = createHttpAdmissionGate({
    reserveUrl: "https://example.invalid/reserve",
    outcomeUrlTemplate: "https://example.invalid/{reservationId}/outcome",
    sourceOrigin: "https://example.invalid",
    bearer: "synthetic-bearer",
    localGate: { acquire: async () => ({}), release },
    serviceFetch,
  });
  return { gate, bodies, release, serviceFetch };
}
async function send(gate: Gate, outcome: GateOutcome) {
  const ticket = await gate.acquire(request, gate.dispatch);
  await gate.dispatch!(ticket, request, (mark) => {
    mark();
    return Promise.resolve(new Response());
  });
  await gate.release(ticket, outcome);
}

it.each([2_147_483_648, Number.MAX_SAFE_INTEGER])(
  "forwards a safe retry delay of %s milliseconds unchanged",
  async (retryAfterMs) => {
    const { gate, bodies, release } = setup();
    await send(gate, {
      ok: false,
      error: "rate_limited",
      status: 429,
      retryAfterMs,
    });
    expect(bodies[1]).toEqual({
      result: "rate_limited",
      status: 429,
      errorCode: "rate_limited",
      retryAfterMs,
    });
    expect(release).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ retryAfterMs }),
    );
    await expect(gate.acquire(request, gate.dispatch)).rejects.toBeInstanceOf(
      AdmissionError,
    );
  },
);

it.each([
  { error: "http_error", status: 403 },
  { error: "access_blocked", status: 200 },
] as const)(
  "preserves a block with the maximum safe delay",
  async ({ error, status }) => {
    const { gate, bodies } = setup();
    await send(gate, {
      ok: false,
      error,
      status,
      retryAfterMs: Number.MAX_SAFE_INTEGER,
    });
    expect(bodies[1]).toEqual({
      result: "access_blocked",
      status,
      errorCode: error,
      retryAfterMs: Number.MAX_SAFE_INTEGER,
    });
    await expect(gate.acquire(request, gate.dispatch)).rejects.toBeInstanceOf(
      AdmissionError,
    );
  },
);

it.each([
  {
    outcome: { ok: false, error: "http_error", status: 403 },
    result: "access_blocked",
    errorCode: "http_error",
  },
  {
    outcome: { ok: false, error: "rate_limited", status: 429 },
    result: "rate_limited",
    errorCode: "rate_limited",
  },
  {
    outcome: { ok: false, error: "access_blocked", status: 200 },
    result: "access_blocked",
    errorCode: "access_blocked",
  },
] as const)(
  "still reports the observed $status block when retry delay is malformed",
  async ({ outcome, result, errorCode }) => {
    for (const delay of [
      -1,
      1.5,
      NaN,
      Infinity,
      Number.MAX_SAFE_INTEGER + 1,
      "invalid",
    ]) {
      const { gate, bodies, release, serviceFetch } = setup();
      await send(gate, {
        ...outcome,
        retryAfterMs: delay,
      } as unknown as GateOutcome);
      expect(bodies[1]).toEqual({ result, status: outcome.status, errorCode });
      expect(release.mock.calls[0]![1]).not.toHaveProperty("retryAfterMs");
      await expect(gate.acquire(request, gate.dispatch)).rejects.toBeInstanceOf(
        AdmissionError,
      );
      expect(serviceFetch).toHaveBeenCalledTimes(2);
    }
  },
);
