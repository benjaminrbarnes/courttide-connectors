import { describe, expect, it, vi } from "vitest";
import {
  AdmissionError,
  admissionEndpoints,
  assertRecorded,
  parseReserve,
  postAdmission,
} from "../packages/connectors/src/runtime/admission-protocol.js";

const id = "00000000-0000-4000-8000-000000000001";
const owner = "00000000-0000-4000-8000-000000000002";
const config = {
  reserveUrl: "https://example.invalid/reserve",
  outcomeUrlTemplate: "https://example.invalid/{reservationId}/outcome",
  sourceOrigin: "https://example.invalid",
  bearer: "synthetic-bearer",
};
const reserved = {
  result: "reserved",
  reservationId: id,
  allowanceOwner: owner,
  budgetDate: "2026-11-04",
  used: 1,
  cap: 10,
  warningCrossed: false,
};
function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("admission service protocol", () => {
  it("accepts same-origin HTTPS endpoints and substitutes only a UUID path segment", () => {
    const endpoints = admissionEndpoints(config);
    expect(endpoints.outcome(id)).toBe(`https://example.invalid/${id}/outcome`);
    expect(endpoints.sourceOrigin).toBe("https://example.invalid");
    expect(() => endpoints.outcome("../example")).toThrow(AdmissionError);
    expect(
      admissionEndpoints({
        ...config,
        reserveUrl: "http://127.0.0.1:1234/reserve",
        outcomeUrlTemplate: "http://127.0.0.1:1234/{reservationId}/outcome",
      }).reserve,
    ).toContain("127.0.0.1");
  });

  it.each([
    { reserveUrl: "http://example.invalid/reserve" },
    { reserveUrl: "https://user@example.invalid/reserve" },
    { reserveUrl: "https://example.invalid/reserve?example=1" },
    { reserveUrl: "https://example.invalid/reserve?" },
    { reserveUrl: "https://example.invalid/reserve#" },
    {
      reserveUrl:
        "https://00000000-0000-4000-8000-000000000000.example.invalid/reserve",
      outcomeUrlTemplate:
        "https://{reservationId}.example.invalid/00000000-0000-4000-8000-000000000000/outcome",
    },
    { outcomeUrlTemplate: "https://example.invalid/outcome" },
    {
      outcomeUrlTemplate:
        "https://example.invalid/{reservationId}/{reservationId}",
    },
    {
      outcomeUrlTemplate:
        "https://example.invalid/example-{reservationId}/outcome",
    },
    { outcomeUrlTemplate: "https://other.invalid/{reservationId}/outcome" },
    { sourceOrigin: "https://example.invalid/path" },
    { bearer: "synthetic bearer" },
    { bearer: "" },
  ])("rejects unsafe endpoint configuration", (change) => {
    expect(() => admissionEndpoints({ ...config, ...change })).toThrow(
      AdmissionError,
    );
  });

  it("validates strict reservation, deferral and recording shapes", () => {
    expect(parseReserve(reserved)).toEqual(reserved);
    expect(
      parseReserve({
        ...reserved,
        used: 2_147_483_648,
        cap: Number.MAX_SAFE_INTEGER,
      }),
    ).toMatchObject({ used: 2_147_483_648, cap: Number.MAX_SAFE_INTEGER });
    expect(
      parseReserve({
        result: "deferred",
        deferUntil: null,
        operatorHold: true,
      }),
    ).toEqual({ result: "deferred", deferUntil: null, operatorHold: true });
    for (const bad of [
      { ...reserved, reservationId: "bad" },
      { ...reserved, allowanceOwner: "bad" },
      { ...reserved, budgetDate: "2026-02-30" },
      { ...reserved, used: -1 },
      { ...reserved, used: 11 },
      { ...reserved, cap: 0 },
      { ...reserved, cap: Number.MAX_SAFE_INTEGER + 1 },
      { ...reserved, warningCrossed: "true" },
      { ...reserved, extra: true },
      { result: "deferred", deferUntil: "tomorrow", operatorHold: true },
    ])
      expect(() => parseReserve(bad)).toThrow(AdmissionError);
    expect(() => assertRecorded({ recorded: true })).not.toThrow();
    expect(() => assertRecorded({ recorded: true, extra: true })).toThrow(
      AdmissionError,
    );
  });

  it("sends only the approved JSON body and never follows redirects", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json(reserved));
    const value = await postAdmission({
      url: config.reserveUrl,
      bearer: config.bearer,
      body: { purpose: "calendar" },
      serviceFetch: fetcher,
    });
    expect(value).toEqual(reserved);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(config.reserveUrl);
    expect(init).toMatchObject({
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
    });
    expect(JSON.parse(String(init?.body))).toEqual({ purpose: "calendar" });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer synthetic-bearer",
    );
  });

  it.each([401, 409, 302, 500])(
    "fails closed for service status %s",
    async (status) => {
      const fetcher = vi.fn<typeof fetch>(
        async () => new Response(null, { status }),
      );
      await expect(
        postAdmission({
          url: config.reserveUrl,
          bearer: config.bearer,
          body: { purpose: "calendar" },
          serviceFetch: fetcher,
        }),
      ).rejects.toBeInstanceOf(AdmissionError);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it("redacts transport failures and rejects oversized or invalid replies", async () => {
    const secret = "synthetic-private-detail";
    const failure = vi.fn<typeof fetch>(async () => {
      throw new Error(secret);
    });
    let caught: unknown;
    try {
      await postAdmission({
        url: config.reserveUrl,
        bearer: config.bearer,
        body: {},
        serviceFetch: failure,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AdmissionError);
    expect(JSON.stringify(caught)).not.toContain(secret);
    expect(String(caught)).not.toContain(secret);
    for (const body of ["x".repeat(8_193), "{"]) {
      await expect(
        postAdmission({
          url: config.reserveUrl,
          bearer: config.bearer,
          body: {},
          serviceFetch: async () =>
            new Response(body, {
              headers: { "content-type": "application/json" },
            }),
        }),
      ).rejects.toBeInstanceOf(AdmissionError);
    }
  });

  it("cancels a lost reserve response without retrying", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const pending = postAdmission({
      url: config.reserveUrl,
      bearer: config.bearer,
      body: { purpose: "calendar" },
      serviceFetch: fetcher,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(AdmissionError);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});
