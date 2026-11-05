import { expect, it, vi } from "vitest";
import {
  AdmissionError,
  activeNetLegacyProfile,
  ConnectorError,
  createHttpAdmissionGate,
} from "../packages/connectors/src/index.js";
import type {
  Gate,
  GateOutcome,
  GateRequest,
} from "../packages/connectors/src/index.js";
import { createRecordingGate } from "../packages/connectors/src/testing/index.js";
import { activeRequest, activeTenant, runtime } from "./runtime-support.js";

const id = "00000000-0000-4000-8000-000000000001";
const nextId = "00000000-0000-4000-8000-000000000002";
const owner = "00000000-0000-4000-8000-000000000003";
const config = {
  reserveUrl: "https://example.invalid/reserve",
  outcomeUrlTemplate: "https://example.invalid/{reservationId}/outcome",
  sourceOrigin: activeTenant.origin,
  bearer: "synthetic-bearer",
};
const request: GateRequest = {
  court: "900001",
  purpose: "calendar",
  method: "GET",
  url: activeRequest().url.href,
};
const reserved = (reservationId = id) => ({
  result: "reserved",
  reservationId,
  allowanceOwner: owner,
  budgetDate: "2026-11-04",
  used: 1,
  cap: 10,
  warningCrossed: false,
});
function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}
function service() {
  const calls: { url: string; body: unknown; init: RequestInit }[] = [];
  let reservation = 0;
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    calls.push({ url, body: JSON.parse(String(init?.body)), init: init! });
    return url.endsWith("/reserve")
      ? json(reserved(reservation++ ? nextId : id))
      : json({ recorded: true });
  });
  return { calls, fetcher };
}
function fixture(
  serviceFetch: typeof fetch,
  signal?: AbortSignal,
  localGate?: Gate,
) {
  const recording = createRecordingGate();
  const gate = createHttpAdmissionGate({
    ...config,
    localGate: localGate ?? recording.gate,
    serviceFetch,
    signal,
  });
  return { gate, recording };
}

it("binds one real fetch to its ticket and reports only approved fields", async () => {
  const remote = service();
  const { gate, recording } = fixture(remote.fetcher);
  const provider = vi.fn<typeof fetch>(
    async () =>
      new Response("{}", { headers: { "content-type": "application/json" } }),
  );
  const client = runtime(activeTenant, activeNetLegacyProfile, gate, provider);
  await client.execute(() => client.http.request(activeRequest()));
  expect(provider).toHaveBeenCalledOnce();
  expect(provider.mock.calls[0]![1]).toMatchObject({
    method: "GET",
    redirect: "manual",
    credentials: "omit",
  });
  expect(remote.calls.map((call) => call.body)).toEqual([
    { purpose: "calendar" },
    { result: "success", status: 200 },
  ]);
  expect(remote.calls.every((call) => call.init.redirect === "manual")).toBe(
    true,
  );
  expect(
    remote.calls.every(
      (call) =>
        new Headers(call.init.headers).get("authorization") ===
        "Bearer synthetic-bearer",
    ),
  ).toBe(true);
  expect(JSON.stringify(remote.calls.map((call) => call.body))).not.toContain(
    "synthetic-bearer",
  );
  expect(JSON.stringify(remote.calls.map((call) => call.body))).not.toContain(
    activeTenant.origin,
  );
  expect(recording.calls).toHaveLength(2);
});

it.each([
  {
    value: { result: "deferred", deferUntil: null, operatorHold: true },
    code: "deferred",
  },
  {
    value: { result: "reserved", reservationId: "invalid" },
    code: "unavailable",
  },
])(
  "does not send after deferred or malformed admission",
  async ({ value, code }) => {
    const remote = vi.fn<typeof fetch>(async () => json(value));
    const { gate, recording } = fixture(remote);
    const provider = vi.fn<typeof fetch>();
    const client = runtime(
      activeTenant,
      activeNetLegacyProfile,
      gate,
      provider,
    );
    await expect(client.http.request(activeRequest())).rejects.toMatchObject({
      code,
    });
    await expect(client.http.request(activeRequest())).rejects.toBeInstanceOf(
      AdmissionError,
    );
    expect(remote).toHaveBeenCalledOnce();
    expect(provider).not.toHaveBeenCalled();
    expect(recording.calls).toHaveLength(2);
  },
);

it.each([401, 409, 500])(
  "fails closed on service %s without retry",
  async (status) => {
    const remote = vi.fn<typeof fetch>(
      async () => new Response(null, { status }),
    );
    const { gate } = fixture(remote);
    await expect(gate.acquire(request, gate.dispatch)).rejects.toBeInstanceOf(
      AdmissionError,
    );
    await expect(gate.acquire(request, gate.dispatch)).rejects.toBeInstanceOf(
      AdmissionError,
    );
    expect(remote).toHaveBeenCalledOnce();
  },
);

it("does not reserve for a different origin or partial cancellation", async () => {
  const remote = service();
  const controller = new AbortController();
  const { gate } = fixture(remote.fetcher, controller.signal);
  await expect(
    gate.acquire(
      { ...request, url: "https://example.invalid/other" },
      gate.dispatch,
    ),
  ).rejects.toBeInstanceOf(AdmissionError);
  controller.abort();
  await expect(gate.acquire(request, gate.dispatch)).rejects.toBeInstanceOf(
    AdmissionError,
  );
  expect(remote.fetcher).not.toHaveBeenCalled();
});

it("reports not_sent only when cancellation prevents the guarded send", async () => {
  const remote = service();
  const controller = new AbortController();
  const { gate } = fixture(remote.fetcher, controller.signal);
  const ticket = await gate.acquire(request, gate.dispatch);
  controller.abort();
  const provider = vi.fn<typeof fetch>();
  expect(() =>
    gate.dispatch!(ticket, request, (mark) => {
      mark();
      return provider("https://example.invalid");
    }),
  ).toThrow(AdmissionError);
  await gate.release(ticket, { ok: false, error: "http_error" });
  expect(provider).not.toHaveBeenCalled();
  expect(remote.calls[1]!.body).toEqual({ result: "not_sent" });
});

it.each([
  [
    { ok: false, error: "rate_limited", status: 429, retryAfterMs: 3000 },
    {
      result: "rate_limited",
      status: 429,
      errorCode: "rate_limited",
      retryAfterMs: 3000,
    },
  ],
  [
    { ok: false, error: "access_blocked", status: 403 },
    { result: "access_blocked", status: 403, errorCode: "access_blocked" },
  ],
  [
    { ok: false, error: "access_blocked", status: 200 },
    { result: "access_blocked", status: 200, errorCode: "access_blocked" },
  ],
  [
    { ok: false, error: "access_blocked", status: 503 },
    { result: "access_blocked", status: 503, errorCode: "access_blocked" },
  ],
  [
    { ok: false, error: "schema_changed", status: 200 },
    { result: "http_error", status: 200, errorCode: "schema_changed" },
  ],
  [
    { ok: false, error: "http_error", status: 500 },
    { result: "http_error", status: 500, errorCode: "http_error" },
  ],
  [{ ok: false, error: "http_error" }, { result: "unknown" }],
] as const)("reports a bounded observed outcome", async (outcome, expected) => {
  const remote = service();
  const { gate } = fixture(remote.fetcher);
  const ticket = await gate.acquire(request, gate.dispatch);
  await gate.dispatch!(ticket, request, (mark) => {
    mark();
    return Promise.resolve(new Response());
  });
  await gate.release(ticket, outcome as GateOutcome);
  expect(remote.calls[1]!.body).toEqual(expected);
  if (
    expected.result === "access_blocked" ||
    expected.result === "rate_limited" ||
    expected.result === "unknown"
  ) {
    await expect(gate.acquire(request, gate.dispatch)).rejects.toBeInstanceOf(
      AdmissionError,
    );
    expect(remote.calls).toHaveLength(2);
  }
});

it("records an initiated fetch failure as unknown and stops", async () => {
  const remote = service();
  const { gate } = fixture(remote.fetcher);
  const provider = vi.fn<typeof fetch>(async () => {
    throw new Error("synthetic-provider-secret");
  });
  const client = runtime(activeTenant, activeNetLegacyProfile, gate, provider);
  await expect(client.http.request(activeRequest())).rejects.toBeInstanceOf(
    ConnectorError,
  );
  expect(remote.calls[1]!.body).toEqual({ result: "unknown" });
  await expect(client.http.request(activeRequest())).rejects.toBeInstanceOf(
    AdmissionError,
  );
  expect(provider).toHaveBeenCalledOnce();
});

it("stops when outcome recording is ambiguous or refused", async () => {
  const calls: string[] = [];
  const remote = vi.fn<typeof fetch>(async (input) => {
    calls.push(String(input));
    return calls.length === 1
      ? json(reserved())
      : new Response(null, { status: 409 });
  });
  const { gate } = fixture(remote);
  const ticket = await gate.acquire(request, gate.dispatch);
  await gate.dispatch!(ticket, request, (mark) => {
    mark();
    return Promise.resolve(new Response());
  });
  await expect(
    gate.release(ticket, { ok: true, status: 200 }),
  ).rejects.toMatchObject({ code: "conflict" });
  await expect(gate.acquire(request, gate.dispatch)).rejects.toBeInstanceOf(
    AdmissionError,
  );
  expect(calls).toHaveLength(2);
});

it("closes the old ticket before a pending report, preventing same-request ABA reuse", async () => {
  let resolveFirst!: (value: Response) => void;
  const reports: unknown[] = [];
  let count = 0;
  const remote = vi.fn<typeof fetch>((input, init) => {
    if (String(input).endsWith("/reserve"))
      return Promise.resolve(json(reserved(count++ ? nextId : id)));
    reports.push(JSON.parse(String(init?.body)));
    if (reports.length === 1)
      return new Promise((resolve) => {
        resolveFirst = resolve;
      });
    return Promise.resolve(json({ recorded: true }));
  });
  const localGate: Gate = {
    acquire: async () => ({}),
    release: async () => {},
  };
  const { gate } = fixture(remote, undefined, localGate);
  const first = await gate.acquire(request, gate.dispatch);
  const firstRelease = gate.release(first, { ok: false, error: "http_error" });
  const second = await gate.acquire(request, gate.dispatch);
  const provider = vi.fn<typeof fetch>(async () => new Response());
  expect(() =>
    gate.dispatch!(first, request, (mark) => {
      mark();
      return provider("https://example.invalid");
    }),
  ).toThrow(AdmissionError);
  await gate.dispatch!(second, request, (mark) => {
    mark();
    return provider("https://example.invalid");
  });
  expect(() =>
    gate.dispatch!(second, request, (mark) => {
      mark();
      return provider("https://example.invalid");
    }),
  ).toThrow(AdmissionError);
  await gate.release(second, { ok: true, status: 200 });
  resolveFirst(json({ recorded: true }));
  await firstRelease;
  expect(provider).toHaveBeenCalledOnce();
  expect(reports).toEqual([
    { result: "not_sent" },
    { result: "success", status: 200 },
  ]);
});

it("refuses admission from an older runtime without ticket-bound dispatch", async () => {
  const remote = service();
  const { gate, recording } = fixture(remote.fetcher);
  await expect(gate.acquire(request)).rejects.toBeInstanceOf(AdmissionError);
  expect(remote.fetcher).not.toHaveBeenCalled();
  expect(recording.calls).toEqual([]);
});

it.each([
  {
    status: 503,
    headers: new Headers({ location: "https://example.invalid/blocked" }),
    body: null,
  },
  {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    body: "<html><title>Just a moment</title></html>",
  },
])(
  "preserves an observed $status block and stops before another fetch",
  async ({ status, headers, body }) => {
    const remote = service();
    const { gate } = fixture(remote.fetcher);
    const provider = vi.fn<typeof fetch>(
      async () => new Response(body, { status, headers }),
    );
    const profile = {
      ...activeNetLegacyProfile,
      redirectHeaders: ["location"],
    };
    const client = runtime(activeTenant, profile, gate, provider);
    await expect(client.http.request(activeRequest())).rejects.toMatchObject({
      code: "access_blocked",
    });
    expect(remote.calls[1]!.body).toEqual({
      result: "access_blocked",
      status,
      errorCode: "access_blocked",
    });
    await expect(client.http.request(activeRequest())).rejects.toBeInstanceOf(
      AdmissionError,
    );
    expect(provider).toHaveBeenCalledOnce();
    expect(remote.calls).toHaveLength(2);
  },
);

it("honors Retry-After from a rate-limited response and sends no second request", async () => {
  const remote = service();
  const { gate } = fixture(remote.fetcher);
  const provider = vi.fn<typeof fetch>(
    async () =>
      new Response(null, { status: 429, headers: { "retry-after": "23" } }),
  );
  const client = runtime(activeTenant, activeNetLegacyProfile, gate, provider);
  await expect(client.http.request(activeRequest())).rejects.toMatchObject({
    code: "rate_limited",
  });
  expect(remote.calls[1]!.body).toEqual({
    result: "rate_limited",
    status: 429,
    errorCode: "rate_limited",
    retryAfterMs: 23_000,
  });
  await expect(client.http.request(activeRequest())).rejects.toBeInstanceOf(
    AdmissionError,
  );
  expect(provider).toHaveBeenCalledOnce();
});

it("keeps a 429 challenge classified as an explicit block", async () => {
  const remote = service();
  const { gate } = fixture(remote.fetcher);
  const ticket = await gate.acquire(request, gate.dispatch);
  await gate.dispatch!(ticket, request, (mark) => {
    mark();
    return Promise.resolve(new Response());
  });
  await gate.release(ticket, {
    ok: false,
    error: "access_blocked",
    status: 429,
  });
  expect(remote.calls[1]!.body).toEqual({
    result: "access_blocked",
    status: 429,
    errorCode: "access_blocked",
  });
  await expect(gate.acquire(request, gate.dispatch)).rejects.toBeInstanceOf(
    AdmissionError,
  );
});

it("does not retry a lost outcome or expose service failure text", async () => {
  let calls = 0;
  const remote = vi.fn<typeof fetch>(async () => {
    if (calls++ === 0) return json(reserved());
    throw new Error("synthetic-private-service-detail");
  });
  const { gate } = fixture(remote);
  const ticket = await gate.acquire(request, gate.dispatch);
  await gate.dispatch!(ticket, request, (mark) => {
    mark();
    return Promise.resolve(new Response());
  });
  let failure: unknown;
  try {
    await gate.release(ticket, { ok: true, status: 200 });
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(AdmissionError);
  expect(String(failure) + JSON.stringify(failure)).not.toContain(
    "synthetic-private-service-detail",
  );
  await expect(gate.acquire(request, gate.dispatch)).rejects.toBeInstanceOf(
    AdmissionError,
  );
  expect(remote).toHaveBeenCalledTimes(2);
});

it("does not reserve after cancellation while waiting for local pacing", async () => {
  const remote = service();
  const controller = new AbortController();
  let grant!: (ticket: object) => void;
  const release = vi.fn(async () => {});
  const localGate: Gate = {
    acquire: () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
    release,
  };
  const { gate } = fixture(remote.fetcher, controller.signal, localGate);
  const pending = gate.acquire(request, gate.dispatch);
  controller.abort();
  grant({});
  await expect(pending).rejects.toBeInstanceOf(AdmissionError);
  expect(remote.fetcher).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledOnce();
});

it("never retries a lost reservation response or sends a provider request", async () => {
  const controller = new AbortController();
  const remote = vi.fn<typeof fetch>(() => new Promise(() => {}));
  const { gate } = fixture(remote, controller.signal);
  const provider = vi.fn<typeof fetch>();
  const client = runtime(activeTenant, activeNetLegacyProfile, gate, provider, {
    signal: controller.signal,
  });
  const pending = client.http.request(activeRequest());
  await vi.waitFor(() => expect(remote).toHaveBeenCalledOnce());
  controller.abort();
  await expect(pending).rejects.toBeInstanceOf(AdmissionError);
  await expect(client.http.request(activeRequest())).rejects.toBeInstanceOf(
    AdmissionError,
  );
  expect(remote).toHaveBeenCalledOnce();
  expect(provider).not.toHaveBeenCalled();
});
