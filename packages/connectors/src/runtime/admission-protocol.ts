import { isIP } from "node:net";
import { z } from "zod";
import { bounded } from "./async.js";

const MAX_REPLY_BYTES = 8 * 1024;
const SERVICE_TIMEOUT_MS = 10_000;
const EXAMPLE_ID = "00000000-0000-4000-8000-000000000000";
const marker = "{reservationId}";
const uuid = z.uuid();
const reserveReply = z.discriminatedUnion("result", [
  z
    .strictObject({
      result: z.literal("reserved"),
      reservationId: uuid,
      allowanceOwner: uuid,
      budgetDate: z.iso.date(),
      used: z.int().min(0),
      cap: z.int().min(1),
      warningCrossed: z.boolean(),
    })
    .refine((value) => value.used <= value.cap),
  z.strictObject({
    result: z.literal("deferred"),
    deferUntil: z.iso.datetime().nullable(),
    operatorHold: z.boolean(),
  }),
]);
const recordedReply = z.strictObject({ recorded: z.literal(true) });

export type AdmissionErrorCode =
  "deferred" | "unauthorized" | "conflict" | "unavailable" | "cancelled";

/** Contains only fixed codes and validated deferral controls, never server text. */
export class AdmissionError extends Error {
  override name = "AdmissionError";
  constructor(
    public readonly code: AdmissionErrorCode,
    public readonly deferUntil: string | null = null,
    public readonly operatorHold = false,
  ) {
    super(
      code === "deferred"
        ? "Admission deferred"
        : "Admission service unavailable",
    );
  }
}

function invalid(): never {
  throw new AdmissionError("unavailable");
}

function loopback(url: URL): boolean {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return (
    url.protocol === "http:" &&
    ((isIP(host) === 4 && host.startsWith("127.")) ||
      (isIP(host) === 6 && host === "::1"))
  );
}

function safeUrl(value: string): URL {
  if (typeof value !== "string" || value.length > 4_096) return invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return invalid();
  }
  if (
    !(url.protocol === "https:" || loopback(url)) ||
    url.username ||
    url.password ||
    url.href.includes("?") ||
    url.href.includes("#")
  )
    return invalid();
  return url;
}

export function admissionEndpoints(options: {
  reserveUrl: string;
  outcomeUrlTemplate: string;
  sourceOrigin: string;
  bearer: string;
}) {
  const reserve = safeUrl(options.reserveUrl);
  const template = options.outcomeUrlTemplate;
  if (
    typeof template !== "string" ||
    template.split(marker).length !== 2 ||
    template.includes(EXAMPLE_ID)
  )
    return invalid();
  const outcome = safeUrl(template.replace(marker, EXAMPLE_ID));
  const source = safeUrl(options.sourceOrigin);
  if (
    outcome.origin !== reserve.origin ||
    !outcome.pathname.split("/").includes(EXAMPLE_ID) ||
    source.pathname !== "/" ||
    typeof options.bearer !== "string" ||
    !/^[\x21-\x7e]{1,2048}$/.test(options.bearer)
  )
    return invalid();
  return {
    reserve: reserve.href,
    outcome(reservationId: string) {
      if (!uuid.safeParse(reservationId).success) return invalid();
      return outcome.href.replace(EXAMPLE_ID, reservationId);
    },
    sourceOrigin: source.origin,
    bearer: options.bearer,
  };
}

export async function postAdmission(options: {
  url: string;
  bearer: string;
  body: object;
  serviceFetch: typeof fetch;
  signal?: AbortSignal;
}): Promise<unknown> {
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal;
  const timer = setTimeout(() => controller.abort(), SERVICE_TIMEOUT_MS);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (signal.aborted) throw new AdmissionError("cancelled");
    const fetching = options.serviceFetch(options.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.bearer}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(options.body),
      credentials: "omit",
      redirect: "manual",
      cache: "no-store",
      signal,
    });
    void fetching
      .then(
        (late) => {
          if (signal.aborted && late instanceof Response)
            void late.body?.cancel().catch(() => {});
        },
        () => {},
      )
      .catch(() => {});
    response = await bounded(
      fetching,
      signal,
      () => new AdmissionError("unavailable"),
    );
    if (!(response instanceof Response) || response.redirected)
      return invalid();
    if (response.status === 401) throw new AdmissionError("unauthorized");
    if (response.status === 409) throw new AdmissionError("conflict");
    if (response.status !== 200 || response.headers.has("location"))
      return invalid();
    const type = response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (type !== "application/json" || !response.body) return invalid();
    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const part = await bounded(
        reader.read(),
        signal,
        () => new AdmissionError("unavailable"),
      );
      if (part.done) break;
      if (
        !(part.value instanceof Uint8Array) ||
        part.value.byteLength > MAX_REPLY_BYTES - size
      )
        return invalid();
      chunks.push(part.value);
      size += part.value.byteLength;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof AdmissionError) throw error;
    throw new AdmissionError("unavailable");
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      try {
        reader.releaseLock();
      } catch {
        /* A pending read may still settle. */
      }
    } else if (response instanceof Response) {
      void response.body?.cancel().catch(() => {});
    }
  }
}

export function parseReserve(value: unknown) {
  const result = reserveReply.safeParse(value);
  if (!result.success) return invalid();
  return result.data;
}
export function assertRecorded(value: unknown): void {
  if (!recordedReply.safeParse(value).success) invalid();
}
