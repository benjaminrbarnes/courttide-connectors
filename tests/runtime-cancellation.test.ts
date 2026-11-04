import { afterEach, expect, it, vi } from "vitest";
import {
  activeNetLegacyProfile,
  civicRecLegacyProfile,
  ConnectorError,
} from "../packages/connectors/src/index.js";
import { createRecordingGate } from "../packages/connectors/src/testing/index.js";
import {
  activeRequest,
  activeTenant,
  civicRequest,
  civicTenant,
  runtime,
} from "./runtime-support.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it.each(["headers", "body"])(
  "uses CivicRec's AbortError deadline while waiting for %s",
  async (stage) => {
    vi.useFakeTimers();
    const recording = createRecordingGate();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      signal = init!.signal!;
      if (stage === "headers") return new Promise(() => {});
      return new Response(new ReadableStream(), {
        headers: { "content-type": "application/json" },
      });
    });
    const client = runtime(
      civicTenant,
      civicRecLegacyProfile,
      recording.gate,
      fetcher,
    );
    const pending = client
      .execute(() => client.http.request(civicRequest()))
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(signal?.aborted).toBe(false);
    expect(recording.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({
      code: "http_error",
      retryable: true,
    });
    expect(signal?.reason).toMatchObject({
      name: "AbortError",
      message: "This operation was aborted",
    });
    expect(recording.calls.at(-1)).toMatchObject({
      type: "release",
      outcome: { error: "http_error", retryable: true },
    });
  },
);

it.each(["headers", "body"])(
  "keeps a typed parent cancellation reason out of CivicRec's %s failure classification",
  async (stage) => {
    const recording = createRecordingGate();
    const parent = new AbortController();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn<typeof fetch>(async (_input, init) => {
      signal = init!.signal!;
      if (stage === "headers") return new Promise(() => {});
      return new Response(new ReadableStream(), {
        headers: { "content-type": "application/json" },
      });
    });
    const client = runtime(
      civicTenant,
      civicRecLegacyProfile,
      recording.gate,
      fetcher,
      {
        signal: parent.signal,
      },
    );
    const pending = client
      .execute(() => client.http.request(civicRequest()))
      .catch((e: unknown) => e);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    const reason = new ConnectorError("access_blocked");
    parent.abort(reason);
    expect(await pending).toMatchObject({
      code: "http_error",
      retryable: true,
    });
    expect(signal?.reason).toBe(reason);
    expect(recording.calls.at(-1)).toMatchObject({
      type: "release",
      outcome: { error: "http_error", retryable: true },
    });
  },
);

it("aborts CivicRec before an unread body's cancellation and releases without waiting for the deadline", async () => {
  vi.useFakeTimers();
  const events: string[] = [];
  let signal!: AbortSignal;
  const client = runtime(
    civicTenant,
    civicRecLegacyProfile,
    {
      acquire: async () => ({}),
      release: async () => {
        events.push("release");
      },
    },
    async (_input, init) => {
      signal = init!.signal!;
      signal.addEventListener("abort", () => events.push("abort"), {
        once: true,
      });
      return new Response(
        new ReadableStream({
          cancel() {
            events.push(`cancel:${signal.aborted}`);
            if (!signal.aborted)
              return new Promise<void>((resolve) => {
                signal.addEventListener("abort", () => resolve(), {
                  once: true,
                });
              });
          },
        }),
        { status: 403 },
      );
    },
  );
  const pending = client
    .execute(() => client.http.request(civicRequest()))
    .catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(0);
  expect(events).toEqual(["abort", "cancel:true", "release"]);
  expect(await pending).toMatchObject({
    code: "access_blocked",
    retryable: false,
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("leaves ActiveNet's native timeout signal alive after rejected-body disposal", async () => {
  const timeout = vi.spyOn(AbortSignal, "timeout");
  const events: string[] = [];
  let signal!: AbortSignal;
  const client = runtime(
    activeTenant,
    activeNetLegacyProfile,
    {
      acquire: async () => ({}),
      release: async () => {
        events.push("release");
      },
    },
    async (_input, init) => {
      signal = init!.signal!;
      return new Response(
        new ReadableStream({
          cancel() {
            events.push(`cancel:${signal.aborted}`);
          },
        }),
        { status: 403 },
      );
    },
  );
  await expect(
    client.execute(() => client.http.request(activeRequest())),
  ).rejects.toMatchObject({ code: "access_blocked" });
  expect(timeout).toHaveBeenCalledExactlyOnceWith(15_000);
  expect(signal.aborted).toBe(false);
  expect(signal.reason).toBeUndefined();
  expect(events).toEqual(["cancel:false", "release"]);
});
