import { ConnectorError } from "../contract/errors.js";
import type {
  HttpRequest,
  HttpResponse,
  TransportProfile,
} from "../contract/types.js";
import { bounded, transportFailure } from "./async.js";
import { detectChallenge } from "./challenge.js";
import { parseRetryAfter } from "./retry-after.js";
import { rejectedChallenge } from "./rejected-challenge.js";

const MAX_BYTES = 1024 * 1024;

export interface ResponseClock {
  now(): Date;
  receivedAt(): string;
  deadline(): void;
  signal: AbortSignal;
  abortError?: () => unknown;
  beforeDispose?: () => void;
  normalizeFailure?: (error: unknown) => unknown;
  inspectRejectedChallenge?: boolean;
}

function checkStatus(
  response: Response,
  profile: TransportProfile,
  clock: ResponseClock,
): void {
  if (
    response.redirected ||
    (response.status >= 300 && response.status < 400) ||
    profile.redirectHeaders.some((name) => response.headers.has(name)) ||
    response.status === 401 ||
    response.status === 403
  )
    throw new ConnectorError("access_blocked");
  if (response.status === 429) {
    const reference =
      profile.retryAfter === "lenient"
        ? new Date(clock.receivedAt())
        : clock.now();
    const retry = parseRetryAfter(
      response.headers.get("retry-after"),
      profile.retryAfter,
      reference,
    );
    throw new ConnectorError(
      "rate_limited",
      retry.retryable,
      retry.retryAfterMs,
    );
  }
  if (response.status >= 500) throw new ConnectorError("http_error", true);
  if (
    profile.successStatuses === "200-only"
      ? response.status !== 200
      : !response.ok
  )
    throw new ConnectorError("http_error");
}

function checkLength(
  response: Response,
  profile: TransportProfile,
): number | null {
  if (!profile.contentLengthChecks) return null;
  const raw = response.headers.get("content-length");
  if (raw === null) return null;
  if (!/^\d{1,10}$/.test(raw) || Number(raw) > MAX_BYTES)
    throw new ConnectorError("schema_changed");
  return Number(raw);
}

function checkType(
  response: Response,
  expected: HttpRequest["expect"],
  profile: TransportProfile,
): void {
  const type = response.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  const allowed =
    expected === "json" ? profile.jsonContentTypes : profile.htmlContentTypes;
  if (!type || !allowed.includes(type))
    throw new ConnectorError("access_blocked");
}

export async function processResponse(
  response: Response,
  request: HttpRequest,
  profile: TransportProfile,
  clock: ResponseClock,
  requestedAt: string,
): Promise<HttpResponse> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    if (response.redirected) throw new ConnectorError("access_blocked");
    const rawType = response.headers.get("content-type")?.toLowerCase() ?? "";
    const classifyJson =
      request.expect === "json" ||
      (request.expect === "html" &&
        profile.classifyJsonForHtml === true &&
        profile.jsonContentTypes.some(
          (type) => rawType === type || rawType.startsWith(`${type};`),
        ));
    const expected = classifyJson ? "json" : request.expect;
    const bodyFirst =
      profile.classificationOrder === "legacy-body-first" &&
      response.status === 200;
    if (!bodyFirst) {
      try {
        checkStatus(response, profile, clock);
      } catch (error) {
        if (
          clock.inspectRejectedChallenge &&
          response.status >= 500 &&
          error instanceof ConnectorError &&
          error.code === "http_error" &&
          (await rejectedChallenge(response, profile, clock))
        )
          throw new ConnectorError("access_blocked");
        throw error;
      }
    }
    const length = checkLength(response, profile);
    if (!bodyFirst) checkType(response, expected, profile);
    if (!response.body && !bodyFirst)
      throw new ConnectorError("schema_changed");
    reader = response.body?.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (reader) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await bounded(reader.read(), clock.signal, clock.abortError);
      } catch (error) {
        throw transportFailure(error, clock.signal, profile);
      }
      clock.deadline();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array))
        throw new ConnectorError("schema_changed");
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw new ConnectorError("schema_changed");
      chunks.push(part.value);
    }
    if (
      length !== null &&
      !response.headers.has("content-encoding") &&
      length !== size
    )
      throw new ConnectorError("http_error");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new ConnectorError("schema_changed");
    }
    clock.deadline();
    const receivedAt = clock.receivedAt();
    if (bodyFirst) {
      checkStatus(response, profile, clock);
      checkType(response, expected, profile);
    }
    if (request.expect === "json" && /^\s*</.test(text))
      throw new ConnectorError("access_blocked");
    if (
      profile.challenge &&
      (profile.challenge.scope === "all" ||
        request.expect === "html" ||
        /^\s*</.test(text)) &&
      detectChallenge(text, profile.challenge)
    )
      throw new ConnectorError("access_blocked");
    let body: unknown = text;
    if (classifyJson) {
      try {
        body = JSON.parse(text);
      } catch {
        throw new ConnectorError("schema_changed");
      }
    }
    await profile.classify?.(body, request);
    return {
      status: response.status,
      headers: new Headers(response.headers),
      text,
      requestedAt,
      receivedAt,
    };
  } catch (error) {
    throw clock.normalizeFailure ? clock.normalizeFailure(error) : error;
  } finally {
    clock.beforeDispose?.();
    try {
      if (reader) await reader.cancel();
      else await response.body?.cancel();
    } catch {
      /* Closed or errored streams are already disposed. */
    } finally {
      reader?.releaseLock();
    }
  }
}
