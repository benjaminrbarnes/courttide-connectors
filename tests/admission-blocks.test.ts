import { expect, it, vi } from "vitest";
import {
  AdmissionError,
  activeNetLegacyProfile,
  ConnectorError,
  createHttpAdmissionGate,
} from "../packages/connectors/src/index.js";
import { createRecordingGate } from "../packages/connectors/src/testing/index.js";
import { activeRequest, activeTenant, runtime } from "./runtime-support.js";

function json(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: new Headers({ "content-type": "application/json" }),
  });
}
function admission() {
  const calls: unknown[] = [];
  const serviceFetch = vi.fn<typeof fetch>(async (input, init) => {
    calls.push(JSON.parse(String(init?.body)));
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
  const local = createRecordingGate();
  const gate = createHttpAdmissionGate({
    reserveUrl: "https://example.invalid/reserve",
    outcomeUrlTemplate: "https://example.invalid/{reservationId}/outcome",
    sourceOrigin: activeTenant.origin,
    bearer: "synthetic-bearer",
    serviceFetch,
    localGate: local.gate,
  });
  return { gate, calls, local };
}
const challenge = "<html><title>Just a moment</title></html>";

it.each([401, 400, 404, 201])(
  "reports a challenge observed with status %s and stops before another fetch",
  async (status) => {
    const { gate, calls } = admission();
    const response = new Response(challenge, {
      status,
      headers: { "content-type": "text/html" },
    });
    const read = vi.spyOn(response.body!, "getReader");
    const provider = vi.fn<typeof fetch>(async () => response);
    const profile = {
      ...activeNetLegacyProfile,
      successStatuses: "200-only" as const,
    };
    const client = runtime(activeTenant, profile, gate, provider);
    await expect(client.http.request(activeRequest())).rejects.toMatchObject({
      code: "access_blocked",
    });
    expect(read).toHaveBeenCalledOnce();
    expect(calls).toEqual([
      { purpose: "calendar" },
      { result: "access_blocked", status, errorCode: "access_blocked" },
    ]);
    await expect(client.http.request(activeRequest())).rejects.toBeInstanceOf(
      AdmissionError,
    );
    expect(provider).toHaveBeenCalledOnce();
  },
);

it.each(["plain", "incomplete"] as const)(
  "reports an inconclusive %s 401 without retrying or claiming a host block",
  async (kind) => {
    const { gate, calls } = admission();
    const body =
      kind === "plain"
        ? "Authorization required"
        : new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<title>Just a"));
            },
            pull(controller) {
              controller.error(new Error("synthetic stream failure"));
            },
          });
    const provider = vi.fn<typeof fetch>(
      async () => new Response(body, { status: 401 }),
    );
    const client = runtime(
      activeTenant,
      activeNetLegacyProfile,
      gate,
      provider,
    );
    await expect(client.http.request(activeRequest())).rejects.toMatchObject({
      code: "http_error",
    });
    expect(calls).toEqual([
      { purpose: "calendar" },
      { result: "http_error", status: 401, errorCode: "http_error" },
    ]);
    expect(provider).toHaveBeenCalledOnce();
    const original = activeRequest();
    const request = {
      court: original.court,
      purpose: original.purpose,
      method: original.method,
      url: original.url.href,
    };
    await expect(gate.acquire(request, gate.dispatch)).rejects.toBeInstanceOf(
      AdmissionError,
    );
    expect(calls).toHaveLength(2);
    expect(provider).toHaveBeenCalledOnce();
  },
);

it("retains ordinary gate 401 classification without reading its body", async () => {
  const local = createRecordingGate();
  const response = new Response(challenge, { status: 401 });
  const read = vi.spyOn(response.body!, "getReader");
  const client = runtime(
    activeTenant,
    activeNetLegacyProfile,
    local.gate,
    async () => response,
  );
  await expect(client.http.request(activeRequest())).rejects.toMatchObject({
    code: "access_blocked",
  });
  expect(read).not.toHaveBeenCalled();
});

it.each([
  { status: 401, code: "http_error" },
  { status: 200, code: "auth_required" },
] as const)(
  "retains a caught authentication failure at $status without reporting a host block",
  async ({ status, code }) => {
    const { gate, calls } = admission();
    const provider = vi.fn<typeof fetch>(
      async () =>
        new Response("{}", {
          status,
          headers: { "content-type": "application/json" },
        }),
    );
    const profile = {
      ...activeNetLegacyProfile,
      classify() {
        throw new ConnectorError("auth_required");
      },
    };
    const client = runtime(activeTenant, profile, gate, provider, {
      leaseScope: "per_read",
    });
    await expect(
      client.execute(async () => {
        await expect(
          client.http.request(activeRequest()),
        ).rejects.toMatchObject({ code });
        return "handled";
      }),
    ).resolves.toBe("handled");
    expect(calls[1]).toEqual({ result: "http_error", status, errorCode: code });
    await expect(
      client.execute(() => client.http.request(activeRequest())),
    ).rejects.toBeInstanceOf(AdmissionError);
    expect(provider).toHaveBeenCalledOnce();
  },
);

it("recognizes a non-leading challenge marker in a successful JSON response", async () => {
  const { gate, calls } = admission();
  const body = JSON.stringify({ message: "<form id='challenge-form'></form>" });
  const provider = vi.fn<typeof fetch>(
    async () =>
      new Response(body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const client = runtime(activeTenant, activeNetLegacyProfile, gate, provider);
  await expect(client.http.request(activeRequest())).rejects.toMatchObject({
    code: "access_blocked",
  });
  expect(calls[1]).toEqual({
    result: "access_blocked",
    status: 200,
    errorCode: "access_blocked",
  });
  await expect(client.http.request(activeRequest())).rejects.toBeInstanceOf(
    AdmissionError,
  );
  expect(provider).toHaveBeenCalledOnce();
});

it("reports a 503 challenge body with its observed status and stops before another fetch", async () => {
  const { gate, calls } = admission();
  const provider = vi.fn<typeof fetch>(
    async () =>
      new Response(challenge, {
        status: 503,
        headers: { "content-type": "text/html" },
      }),
  );
  const client = runtime(activeTenant, activeNetLegacyProfile, gate, provider);
  await expect(client.http.request(activeRequest())).rejects.toMatchObject({
    code: "access_blocked",
  });
  expect(calls).toEqual([
    { purpose: "calendar" },
    { result: "access_blocked", status: 503, errorCode: "access_blocked" },
  ]);
  await expect(client.http.request(activeRequest())).rejects.toBeInstanceOf(
    AdmissionError,
  );
  expect(provider).toHaveBeenCalledOnce();
});

it("retains the ordinary gate's non-200 status-before-body behavior", async () => {
  const local = createRecordingGate();
  const response = new Response(challenge, {
    status: 503,
    headers: { "content-type": "text/html" },
  });
  const read = vi.spyOn(response.body!, "getReader");
  const client = runtime(
    activeTenant,
    activeNetLegacyProfile,
    local.gate,
    async () => response,
  );
  await expect(client.http.request(activeRequest())).rejects.toMatchObject({
    code: "http_error",
  });
  expect(read).not.toHaveBeenCalled();
  expect(local.calls.at(-1)).toMatchObject({
    outcome: { ok: false, status: 503, error: "http_error" },
  });
});

it.each([
  {
    status: 401,
    body: challenge,
    headers: new Headers(),
    result: "access_blocked",
    code: "access_blocked",
  },
  {
    status: 200,
    body: challenge,
    headers: { "content-type": "application/json" },
    result: "access_blocked",
    code: "access_blocked",
  },
  {
    status: 403,
    body: "",
    headers: new Headers(),
    result: "access_blocked",
    code: "access_blocked",
  },
  {
    status: 429,
    body: "",
    headers: new Headers(),
    result: "rate_limited",
    code: "rate_limited",
  },
] as const)(
  "retains a caught $status block through per-read release",
  async ({ status, body, headers, result, code }) => {
    const { gate, calls } = admission();
    const provider = vi.fn<typeof fetch>(
      async () => new Response(body, { status, headers }),
    );
    const client = runtime(
      activeTenant,
      activeNetLegacyProfile,
      gate,
      provider,
      { leaseScope: "per_read" },
    );
    await expect(
      client.execute(async () => {
        await expect(
          client.http.request(activeRequest()),
        ).rejects.toMatchObject({ code });
        return "handled";
      }),
    ).resolves.toBe("handled");
    expect(calls).toEqual([
      { purpose: "calendar" },
      { result, status, errorCode: code },
    ]);
    await expect(
      client.execute(() => client.http.request(activeRequest())),
    ).rejects.toBeInstanceOf(AdmissionError);
    expect(provider).toHaveBeenCalledOnce();
  },
);

it("retains the observed challenge when an outer callback replaces the error", async () => {
  const { gate, calls } = admission();
  const provider = vi.fn<typeof fetch>(
    async () =>
      new Response(challenge, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
  const client = runtime(activeTenant, activeNetLegacyProfile, gate, provider, {
    leaseScope: "per_read",
  });
  await expect(
    client.execute(async () => {
      try {
        await client.http.request(activeRequest());
      } catch {
        throw new Error("example replacement");
      }
    }),
  ).rejects.toThrow("example replacement");
  expect(calls[1]).toEqual({
    result: "access_blocked",
    status: 200,
    errorCode: "access_blocked",
  });
  await expect(
    client.execute(() => client.http.request(activeRequest())),
  ).rejects.toBeInstanceOf(AdmissionError);
  expect(provider).toHaveBeenCalledOnce();
});

it("recognizes challenge markers split across response chunks", async () => {
  const { gate, calls } = admission();
  const chunks = ["<html><title>Just ", "a moment</title></html>"];
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks.shift();
      if (next === undefined) controller.close();
      else controller.enqueue(new TextEncoder().encode(next));
    },
  });
  const client = runtime(
    activeTenant,
    activeNetLegacyProfile,
    gate,
    async () => new Response(stream, { status: 503 }),
  );
  await expect(client.http.request(activeRequest())).rejects.toMatchObject({
    code: "access_blocked",
  });
  expect(calls[1]).toEqual({
    result: "access_blocked",
    status: 503,
    errorCode: "access_blocked",
  });
});

it.each(["plain", "incomplete", "beyond-prefix"] as const)(
  "keeps an inconclusive %s 503 as an HTTP error",
  async (kind) => {
    const { gate, calls } = admission();
    const stream =
      kind === "incomplete"
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("<title>Just a"));
            },
            pull(controller) {
              controller.error(new Error("synthetic stream failure"));
            },
          })
        : kind === "beyond-prefix"
          ? `${"x".repeat(64 * 1024)}${challenge}`
          : "Temporarily unavailable";
    const client = runtime(
      activeTenant,
      activeNetLegacyProfile,
      gate,
      async () => new Response(stream, { status: 503 }),
    );
    await expect(client.http.request(activeRequest())).rejects.toMatchObject({
      code: "http_error",
    });
    expect(calls[1]).toEqual({
      result: "http_error",
      status: 503,
      errorCode: "http_error",
    });
  },
);

it("cancels a stalled 503 probe on the request signal and keeps the observed HTTP error", async () => {
  const { gate, calls } = admission();
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ pull() {}, cancel });
  const response = new Response(stream, { status: 503 });
  const read = vi.spyOn(response.body!, "getReader");
  const controller = new AbortController();
  const client = runtime(
    activeTenant,
    activeNetLegacyProfile,
    gate,
    async () => response,
    { signal: controller.signal },
  );
  const pending = client.http.request(activeRequest());
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  controller.abort();
  await expect(pending).rejects.toMatchObject({ code: "http_error" });
  expect(cancel).toHaveBeenCalledOnce();
  expect(calls[1]).toEqual({
    result: "http_error",
    status: 503,
    errorCode: "http_error",
  });
});
