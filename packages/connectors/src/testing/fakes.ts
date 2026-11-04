import { GateDeferred } from "../contract/errors.js";
import { GateOutcomeSchema, GateRequestSchema } from "../contract/schemas.js";
import type {
  Gate,
  GateOutcome,
  GateRequest,
  Instant,
} from "../contract/types.js";

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: string | null;
  redirected?: boolean;
  failure?: "timeout" | "network";
  bodyFailure?: "timeout" | "network";
}
export interface RecordedFetch {
  url: string;
  init: Record<string, unknown>;
}
export interface FakeFetch {
  fetch: typeof fetch;
  requests: RecordedFetch[];
  remaining(): number;
}

function failure(kind: "timeout" | "network") {
  return kind === "timeout"
    ? new DOMException("Synthetic timeout", "TimeoutError")
    : new TypeError("Synthetic network failure");
}

function cloneHeaders(value: unknown): unknown {
  if (value instanceof Headers) {
    return { kind: "Headers", entries: [...value.entries()] };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => (Array.isArray(entry) ? [...entry] : entry));
  }
  if (value && typeof value === "object") return { ...value };
  return value;
}

export function createFakeFetch(responses: readonly FakeResponse[]): FakeFetch {
  const requests: RecordedFetch[] = [];
  let next = 0;
  const fake: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    const captured: Record<string, unknown> = {};
    if (init) {
      for (const [key, value] of Object.entries(init)) {
        if (value === undefined) continue;
        if (key === "headers") captured[key] = cloneHeaders(value);
        else if (key === "signal")
          captured[key] = value === null ? null : "present";
        else if (
          key === "body" &&
          typeof value !== "string" &&
          value !== null
        ) {
          throw new Error("Fake fetch accepts only string request bodies");
        } else captured[key] = value;
      }
    }
    requests.push({ url, init: captured });
    const response = responses[next++];
    if (!response) throw new Error("Unexpected synthetic request");
    if (response.failure) throw failure(response.failure);
    const body = response.bodyFailure
      ? new ReadableStream({
          start(controller) {
            controller.error(failure(response.bodyFailure!));
          },
        })
      : (response.body ?? null);
    const result = new Response(body, {
      status: response.status ?? 200,
      headers: response.headers,
    });
    if (response.redirected)
      Object.defineProperty(result, "redirected", { value: true });
    return result;
  };
  return { fetch: fake, requests, remaining: () => responses.length - next };
}

export type RecordedGateCall =
  | { type: "acquire"; request: GateRequest }
  | { type: "release"; ticket: number; outcome: GateOutcome };
export interface GateDeferral {
  acquire: number;
  until: Instant;
  reason: "hold" | "pacing" | "budget";
}
export interface RecordingGate {
  gate: Gate;
  calls: RecordedGateCall[];
}

export function createRecordingGate(deferral?: GateDeferral): RecordingGate {
  const calls: RecordedGateCall[] = [];
  const tickets = new Map<object, number>();
  let acquireCount = 0;
  const gate: Gate = {
    async acquire(request) {
      if (!GateRequestSchema.safeParse(request).success)
        throw new Error("Invalid gate request");
      acquireCount += 1;
      calls.push({ type: "acquire", request: { ...request } });
      if (deferral?.acquire === acquireCount)
        throw new GateDeferred(deferral.until, deferral.reason);
      const ticket = {};
      tickets.set(ticket, acquireCount);
      return ticket;
    },
    async release(ticket, outcome) {
      if (!ticket || typeof ticket !== "object" || !tickets.has(ticket)) {
        throw new Error("Unknown or already released gate ticket");
      }
      if (!GateOutcomeSchema.safeParse(outcome).success)
        throw new Error("Invalid gate outcome");
      const number = tickets.get(ticket)!;
      tickets.delete(ticket);
      calls.push({ type: "release", ticket: number, outcome: { ...outcome } });
    },
  };
  return { gate, calls };
}

export function frozenClock(value: Instant): () => Date {
  const instant = new Date(value);
  if (!Number.isFinite(instant.getTime()))
    throw new Error("Invalid synthetic clock");
  return () => new Date(instant.getTime());
}
