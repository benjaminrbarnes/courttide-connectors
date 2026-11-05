import { GateOutcomeSchema, GateRequestSchema } from "../contract/schemas.js";
import type {
  Gate,
  GateOutcome,
  GateRequest,
  GateTicket,
} from "../contract/types.js";
import {
  AdmissionError,
  admissionEndpoints,
  assertRecorded,
  parseReserve,
  postAdmission,
} from "./admission-protocol.js";

export interface HttpAdmissionOptions {
  reserveUrl: string;
  outcomeUrlTemplate: string;
  sourceOrigin: string;
  bearer: string;
  localGate: Gate;
  serviceFetch?: typeof fetch;
  signal?: AbortSignal;
}
type State = {
  reservationId: string;
  localTicket: GateTicket;
  request: GateRequest;
  dispatched: boolean;
  started: boolean;
  closed: boolean;
};

function sameRequest(left: GateRequest, right: GateRequest): boolean {
  return (
    left.court === right.court &&
    left.purpose === right.purpose &&
    left.method === right.method &&
    left.url === right.url
  );
}

function stop(outcome: GateOutcome): boolean {
  return (
    outcome.status === 401 ||
    outcome.status === 403 ||
    outcome.status === 429 ||
    outcome.error === "access_blocked" ||
    outcome.error === "auth_required" ||
    outcome.error === "rate_limited"
  );
}

function validOutcome(raw: GateOutcome): GateOutcome | undefined {
  const { retryAfterMs, ...rest } = raw;
  const delay =
    retryAfterMs === null ||
    (typeof retryAfterMs === "number" &&
      Number.isSafeInteger(retryAfterMs) &&
      retryAfterMs >= 0)
      ? { retryAfterMs }
      : {};
  const parsed = GateOutcomeSchema.safeParse({ ...rest, ...delay });
  return parsed.success ? parsed.data : undefined;
}

function reportBody(state: State, outcome: GateOutcome | undefined): object {
  if (!state.started) return { result: "not_sent" };
  if (!outcome) return { result: "unknown" };
  const status = outcome.status;
  if (!Number.isInteger(status) || status! < 100 || status! > 599)
    return { result: "unknown" };
  const errorCode = outcome.ok ? undefined : outcome.error;
  const retryAfterMs = outcome.retryAfterMs ?? undefined;
  if (outcome.error === "access_blocked")
    return {
      result: "access_blocked",
      status,
      ...(errorCode ? { errorCode } : {}),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  if (status === 429)
    return {
      result: "rate_limited",
      status,
      ...(errorCode ? { errorCode } : {}),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  if (status === 403)
    return {
      result: "access_blocked",
      status,
      ...(errorCode ? { errorCode } : {}),
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  if (outcome.ok && status! >= 200 && status! < 300)
    return { result: "success", status };
  return {
    result: "http_error",
    status,
    ...(errorCode ? { errorCode } : {}),
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  };
}

/** A ticket-bound admission gate. The runtime's dispatch seam owns fetch entry. */
export function createHttpAdmissionGate(options: HttpAdmissionOptions): Gate {
  if (
    !options ||
    typeof options.localGate?.acquire !== "function" ||
    typeof options.localGate?.release !== "function" ||
    options.localGate.dispatch !== undefined ||
    (options.serviceFetch !== undefined &&
      typeof options.serviceFetch !== "function") ||
    (options.signal !== undefined && !(options.signal instanceof AbortSignal))
  )
    throw new AdmissionError("unavailable");
  const endpoints = admissionEndpoints(options);
  const serviceFetch = options.serviceFetch ?? globalThis.fetch;
  const localGate = options.localGate;
  const signal = options.signal;
  if (typeof serviceFetch !== "function")
    throw new AdmissionError("unavailable");
  const tickets = new WeakMap<object, State>();
  let stopped = false;

  async function localFailure(localTicket: GateTicket): Promise<void> {
    try {
      await localGate.release(localTicket, { ok: false, error: "http_error" });
    } catch {
      /* Admission is already stopped. */
    }
  }

  async function finish(state: State, outcome: GateOutcome): Promise<void> {
    if (state.closed) throw new AdmissionError("unavailable");
    state.closed = true;
    const parsed = validOutcome(outcome);
    const body = reportBody(state, parsed);
    const localOutcome: GateOutcome =
      parsed && (!parsed.ok || ("result" in body && body.result === "success"))
        ? parsed
        : { ok: false, error: "http_error" };
    if (
      stop(localOutcome) ||
      parsed?.status === 401 ||
      ("result" in body &&
        ["unknown", "rate_limited", "access_blocked"].includes(
          String(body.result),
        ))
    )
      stopped = true;
    let failed: AdmissionError | undefined;
    try {
      assertRecorded(
        await postAdmission({
          url: endpoints.outcome(state.reservationId),
          bearer: endpoints.bearer,
          body,
          serviceFetch,
        }),
      );
    } catch (error) {
      stopped = true;
      failed =
        error instanceof AdmissionError
          ? error
          : new AdmissionError("unavailable");
    }
    try {
      await localGate.release(state.localTicket, localOutcome);
    } catch {
      stopped = true;
      failed ??= new AdmissionError("unavailable");
    }
    if (failed) throw failed;
  }

  const gate: Gate = {
    async acquire(input, dispatch) {
      // A runtime without ticket-bound dispatch cannot prove a pre-fetch exit.
      if (dispatch !== gate.dispatch) throw new AdmissionError("unavailable");
      const parsed = GateRequestSchema.safeParse(input);
      if (!parsed.success || parsed.data.url.length > 4_096 || stopped)
        throw new AdmissionError("unavailable");
      let url: URL;
      try {
        url = new URL(parsed.data.url);
      } catch {
        throw new AdmissionError("unavailable");
      }
      if (
        url.origin !== endpoints.sourceOrigin ||
        url.username ||
        url.password ||
        url.hash
      )
        throw new AdmissionError("unavailable");
      if (signal?.aborted) throw new AdmissionError("cancelled");
      const request = Object.freeze({ ...parsed.data });
      const localTicket = await localGate.acquire({ ...request });
      let state: State | undefined;
      try {
        if (stopped || signal?.aborted) throw new AdmissionError("cancelled");
        const reply = parseReserve(
          await postAdmission({
            url: endpoints.reserve,
            bearer: endpoints.bearer,
            body: { purpose: request.purpose },
            serviceFetch,
            signal,
          }),
        );
        if (reply.result === "deferred") {
          stopped = true;
          throw new AdmissionError(
            "deferred",
            reply.deferUntil,
            reply.operatorHold,
          );
        }
        state = {
          reservationId: reply.reservationId,
          localTicket,
          request,
          dispatched: false,
          started: false,
          closed: false,
        };
        const ticket = Object.freeze({});
        tickets.set(ticket, state);
        if (stopped || signal?.aborted) {
          stopped = true;
          await finish(state, { ok: false, error: "http_error" });
          throw new AdmissionError("cancelled");
        }
        return ticket;
      } catch (error) {
        stopped = true;
        if (!state) await localFailure(localTicket);
        if (error instanceof AdmissionError) throw error;
        throw new AdmissionError("unavailable");
      }
    },
    dispatch(ticket, request, send) {
      const state =
        ticket && typeof ticket === "object" ? tickets.get(ticket) : undefined;
      if (
        !state ||
        state.closed ||
        state.dispatched ||
        stopped ||
        !sameRequest(state.request, request) ||
        typeof send !== "function"
      )
        throw new AdmissionError("unavailable");
      state.dispatched = true;
      return send(() => {
        if (
          state!.closed ||
          state!.started ||
          stopped ||
          signal?.aborted ||
          !sameRequest(state!.request, request)
        )
          throw new AdmissionError(
            signal?.aborted ? "cancelled" : "unavailable",
          );
        state!.started = true;
      });
    },
    async release(ticket, outcome) {
      const state =
        ticket && typeof ticket === "object" ? tickets.get(ticket) : undefined;
      if (!state) throw new AdmissionError("unavailable");
      await finish(state, outcome);
    },
  };
  return Object.freeze(gate);
}
