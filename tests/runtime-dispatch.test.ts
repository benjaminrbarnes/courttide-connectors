import { describe, expect, it, vi } from "vitest";
import { activeNetLegacyProfile } from "../packages/connectors/src/index.js";
import type {
  Gate,
  GateRequest,
  GateTicket,
} from "../packages/connectors/src/index.js";
import { createRecordingGate } from "../packages/connectors/src/testing/index.js";
import { activeRequest, activeTenant, runtime } from "./runtime-support.js";

function jsonResponse() {
  return new Response("{}", {
    headers: { "content-type": "application/json" },
  });
}

describe("optional ticket-bound runtime dispatch", () => {
  it("passes the exact acquired ticket and request to a synchronous single send", async () => {
    const recording = createRecordingGate();
    const provider = vi.fn<typeof fetch>(async () => jsonResponse());
    let marked = 0;
    const dispatch = vi.fn<NonNullable<Gate["dispatch"]>>(
      (ticket, request, send) => {
        expect(ticket).toBeTruthy();
        expect(request).toEqual({
          court: "900001",
          purpose: "calendar",
          method: "GET",
          url: activeRequest().url.href,
        });
        return send(() => {
          marked += 1;
        });
      },
    );
    const client = runtime(
      activeTenant,
      activeNetLegacyProfile,
      { ...recording.gate, dispatch },
      provider,
    );
    expect((await client.http.request(activeRequest())).status).toBe(200);
    expect(marked).toBe(1);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(provider).toHaveBeenCalledOnce();
    expect(recording.calls).toHaveLength(2);
  });

  it("rejects a fabricated response without entering fetch", async () => {
    const recording = createRecordingGate();
    const provider = vi.fn<typeof fetch>(async () => jsonResponse());
    const gate: Gate = {
      ...recording.gate,
      dispatch: () => Promise.resolve(jsonResponse()),
    };
    const client = runtime(
      activeTenant,
      {
        ...activeNetLegacyProfile,
        transportErrors: "preserve",
        timeoutSignal: "controller",
      },
      gate,
      provider,
    );
    await expect(client.http.request(activeRequest())).rejects.toMatchObject({
      code: "schema_changed",
    });
    expect(provider).not.toHaveBeenCalled();
    expect(recording.calls).toHaveLength(2);
  });

  it("rejects a substituted promise even after a real send and cancels the real response", async () => {
    const recording = createRecordingGate();
    let resolveFetch!: (response: Response) => void;
    const cancel = vi.fn();
    const provider = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const gate: Gate = {
      ...recording.gate,
      dispatch: (_ticket, _request, send) => {
        send(() => {});
        return Promise.resolve(jsonResponse());
      },
    };
    const client = runtime(
      activeTenant,
      {
        ...activeNetLegacyProfile,
        transportErrors: "preserve",
        timeoutSignal: "controller",
      },
      gate,
      provider,
    );
    await expect(client.http.request(activeRequest())).rejects.toMatchObject({
      code: "schema_changed",
    });
    resolveFetch(new Response(new ReadableStream({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
    expect(provider).toHaveBeenCalledOnce();
  });

  it("rejects a swallowed duplicate send instead of accepting the first response", async () => {
    const recording = createRecordingGate();
    const provider = vi.fn<typeof fetch>(async () => jsonResponse());
    const gate: Gate = {
      ...recording.gate,
      dispatch: (_ticket, _request, send) => {
        const original = send(() => {});
        try {
          send(() => {});
        } catch {
          /* A bad hook cannot hide the duplicate. */
        }
        return original;
      },
    };
    const client = runtime(
      activeTenant,
      {
        ...activeNetLegacyProfile,
        transportErrors: "preserve",
        timeoutSignal: "controller",
      },
      gate,
      provider,
    );
    await expect(client.http.request(activeRequest())).rejects.toMatchObject({
      code: "schema_changed",
    });
    expect(provider).toHaveBeenCalledOnce();
  });

  it("invalidates a retained send before the ticket is released", async () => {
    const recording = createRecordingGate();
    const provider = vi.fn<typeof fetch>(async () => jsonResponse());
    let retained!: (mark: () => void) => Promise<Response>;
    const gate: Gate = {
      ...recording.gate,
      dispatch: (_ticket, _request, send) => {
        retained = send;
        return Promise.resolve(jsonResponse());
      },
    };
    const client = runtime(
      activeTenant,
      {
        ...activeNetLegacyProfile,
        transportErrors: "preserve",
        timeoutSignal: "controller",
      },
      gate,
      provider,
    );
    await expect(client.http.request(activeRequest())).rejects.toMatchObject({
      code: "schema_changed",
    });
    expect(() => retained(() => {})).toThrow();
    expect(provider).not.toHaveBeenCalled();
    expect(recording.calls).toHaveLength(2);
  });

  it("rechecks the deadline immediately before marking entry", async () => {
    const recording = createRecordingGate();
    const provider = vi.fn<typeof fetch>(async () => jsonResponse());
    let clock = 0;
    let markCount = 0;
    const gate: Gate = {
      ...recording.gate,
      dispatch: (_ticket: GateTicket, _request: GateRequest, send) => {
        clock = 15_000;
        return send(() => {
          markCount += 1;
        });
      },
    };
    const client = runtime(
      activeTenant,
      {
        ...activeNetLegacyProfile,
        transportErrors: "preserve",
        timeoutSignal: "controller",
      },
      gate,
      provider,
      { monotonicNow: () => clock },
    );
    await expect(client.http.request(activeRequest())).rejects.toBeDefined();
    expect(markCount).toBe(0);
    expect(provider).not.toHaveBeenCalled();
  });
});

it("rechecks an issued cookie after admission and before marking fetch entry", async () => {
  const { civicRecLegacyProfile } =
    await import("../packages/connectors/src/index.js");
  const { bootstrapRequest, civicRequest, civicTenant } =
    await import("./runtime-support.js");
  const recording = createRecordingGate();
  const domains = ["example.invalid"];
  const profile = {
    ...civicRecLegacyProfile,
    cookieJar: { ...civicRecLegacyProfile.cookieJar!, cookieDomains: domains },
    transportErrors: "preserve" as const,
  };
  let entries = 0;
  const gate: Gate = {
    ...recording.gate,
    dispatch: (_ticket, _request, send) => {
      if (entries === 1) domains.length = 0;
      return send(() => {
        entries += 1;
      });
    },
  };
  const provider = vi.fn<typeof fetch>(
    async () =>
      new Response("<html></html>", {
        headers: {
          "content-type": "text/html",
          "set-cookie":
            "ExampleSession=example-token; Domain=example.invalid; Path=/; Secure",
        },
      }),
  );
  const client = runtime(civicTenant, profile, gate, provider);
  await client.http.request(bootstrapRequest());
  const request = civicRequest();
  request.headers = {
    ...request.headers,
    cookie: "ExampleSession=example-token",
  };
  await expect(client.http.request(request)).rejects.toMatchObject({
    code: "schema_changed",
  });
  expect(entries).toBe(1);
  expect(provider).toHaveBeenCalledOnce();
  expect(recording.calls).toHaveLength(4);
});
