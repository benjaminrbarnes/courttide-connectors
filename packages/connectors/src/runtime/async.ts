import { ConnectorError } from "../contract/errors.js";
import type { TransportProfile } from "../contract/types.js";

/** Only caller-approved transport controls can cross a raw fetch/read failure. */
export function transportFailure(
  error: unknown,
  signal: AbortSignal,
  profile: TransportProfile,
): unknown {
  const classified = profile.classifyTransportError?.(error);
  if (classified !== undefined) return classified;
  return profile.transportErrors === "http-only"
    ? new ConnectorError(
        "http_error",
        isTimeoutError(error, signal, profile.abortRetryable),
      )
    : error;
}

export function bounded<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  abortError: () => unknown = () => signal.reason,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(abortError());
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    operation.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

export function isTimeoutError(
  error: unknown,
  signal: AbortSignal,
  abortMode: "timeout-only" | "any-abort",
): boolean {
  if (abortMode === "any-abort") return signal.aborted;
  if (signal.aborted && signal.reason?.name === "TimeoutError") return true;
  const seen = new Set<unknown>();
  let candidate: unknown = error;
  for (
    let depth = 0;
    depth < 5 && candidate && typeof candidate === "object";
    depth += 1
  ) {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    const value = candidate as {
      name?: unknown;
      code?: unknown;
      cause?: unknown;
    };
    if (
      value.name === "TimeoutError" ||
      value.code === "ETIMEDOUT" ||
      value.code === "UND_ERR_CONNECT_TIMEOUT" ||
      value.code === "UND_ERR_HEADERS_TIMEOUT"
    )
      return true;
    candidate = value.cause;
  }
  return false;
}
