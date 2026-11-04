export function bounded<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      cleanup();
      reject(signal.reason);
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
  if (
    signal.aborted &&
    (abortMode === "any-abort" || signal.reason?.name === "TimeoutError")
  )
    return true;
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
