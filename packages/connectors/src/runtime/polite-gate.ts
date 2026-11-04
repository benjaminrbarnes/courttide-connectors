import { ConnectorError, GateDeferred } from "../contract/errors.js";
import type { Gate, GateOutcome, GateRequest } from "../contract/types.js";

interface Waiter {
  resolve(ticket: object): void;
  reject(error: Error): void;
}

export function politeGate(options: {
  minimumGapMs: number;
  monotonicNow?: () => number;
  wallNow?: () => Date;
}): Gate {
  if (!Number.isFinite(options.minimumGapMs) || options.minimumGapMs < 10_000)
    throw new RangeError("minimumGapMs must be at least 10000");
  const now = options.monotonicNow ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => new Date());
  const windows = [
    { count: 6, ms: 60_000 },
    { count: 20, ms: 600_000 },
    { count: 30, ms: 3_600_000 },
  ];
  const starts: number[] = [];
  const queue: Waiter[] = [];
  let current: object | undefined;
  let nextGap = -Infinity;
  let backoffUntil = -Infinity;
  let blocked = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  function deferUntil(time: number): GateDeferred {
    return new GateDeferred(
      new Date(wallNow().getTime() + Math.max(0, time - now())).toISOString(),
      "pacing",
    );
  }

  function drain(): void {
    if (current || !queue.length) return;
    if (blocked) {
      for (const waiter of queue.splice(0))
        waiter.reject(new ConnectorError("access_blocked"));
      return;
    }
    const time = now();
    if (time < backoffUntil) {
      for (const waiter of queue.splice(0))
        waiter.reject(deferUntil(backoffUntil));
      return;
    }
    while (starts.length && starts[0]! <= time - 3_600_000) starts.shift();
    let due = nextGap;
    for (const window of windows) {
      const recent = starts.filter((start) => start > time - window.ms);
      if (recent.length >= window.count)
        due = Math.max(due, recent[recent.length - window.count]! + window.ms);
    }
    if (due > time) {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        drain();
      }, due - time);
      return;
    }
    current = {};
    starts.push(time);
    queue.shift()!.resolve(current);
  }

  return {
    async acquire(_request: GateRequest) {
      return new Promise<object>((resolve, reject) => {
        queue.push({ resolve, reject });
        drain();
      });
    },
    async release(ticket: unknown, outcome: GateOutcome) {
      if (!current || ticket !== current)
        throw new Error("Unknown or already released gate ticket");
      current = undefined;
      const time = now();
      nextGap = time + options.minimumGapMs;
      if (!outcome.ok && outcome.error === "access_blocked") blocked = true;
      if (!outcome.ok && outcome.error === "rate_limited") {
        const delay =
          typeof outcome.retryAfterMs === "number" &&
          Number.isFinite(outcome.retryAfterMs) &&
          outcome.retryAfterMs >= 0
            ? outcome.retryAfterMs
            : 0;
        backoffUntil = Math.max(backoffUntil, time + Math.max(60_000, delay));
      }
      drain();
    },
  };
}
