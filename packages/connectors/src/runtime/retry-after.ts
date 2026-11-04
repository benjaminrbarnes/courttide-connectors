const MAX_DATE_EPOCH_MS = 8_640_000_000_000_000;

export interface RetryAfter {
  retryable: boolean;
  retryAfterMs: number | null;
}

export function parseRetryAfter(
  value: string | null,
  mode: "strict-imf" | "lenient",
  reference: Date,
): RetryAfter {
  const none = { retryable: false, retryAfterMs: null };
  if (!value || !Number.isFinite(reference.getTime())) return none;
  if (mode === "lenient") {
    const delay = /^\d{1,8}$/.test(value)
      ? Number(value) * 1000
      : value.length <= 80
        ? Date.parse(value) - reference.getTime()
        : NaN;
    return Number.isFinite(delay) && delay >= 0
      ? { retryable: true, retryAfterMs: delay }
      : none;
  }
  const maxDelay = MAX_DATE_EPOCH_MS - reference.getTime();
  if (/^\d+$/.test(value)) {
    const seconds = value.replace(/^0+(?=\d)/, "");
    if (seconds.length > 13 || maxDelay < 0) return none;
    const delay = BigInt(seconds) * 1000n;
    return delay <= BigInt(maxDelay)
      ? { retryable: true, retryAfterMs: Number(delay) }
      : none;
  }
  if (
    value.length > 64 ||
    !/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(
      value,
    )
  )
    return none;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toUTCString() !== value)
    return none;
  const delay = Math.max(0, parsed - reference.getTime());
  return Number.isSafeInteger(delay) && delay <= maxDelay
    ? { retryable: true, retryAfterMs: delay }
    : none;
}
