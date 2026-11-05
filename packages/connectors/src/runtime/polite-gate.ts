import { ConnectorError, GateDeferred } from "../contract/errors.js";
import {
  DEFAULT_DEVELOPMENT_GAP_MS,
  MINIMUM_DEVELOPMENT_GAP_MS,
} from "../contract/constants.js";
import type { Gate, GateOutcome, GateRequest } from "../contract/types.js";

interface Waiter {
  resolve(ticket: object): void;
  reject(error: Error): void;
}

export function politeGate(
  options: {
    minimumGapMs?: number;
    monotonicNow?: () => number;
    wallNow?: () => Date;
  } = {},
): Gate {
  const minimumGapMs = options.minimumGapMs ?? DEFAULT_DEVELOPMENT_GAP_MS;
  if (
    !Number.isFinite(minimumGapMs) ||
    minimumGapMs < MINIMUM_DEVELOPMENT_GAP_MS
  )
    throw new RangeError("minimumGapMs must be at least 2000");
  const now = options.monotonicNow ?? (() => performance.now());
  const wallNow = options.wallNow ?? (() => new Date());
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
    if (nextGap > time) {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        drain();
      }, nextGap - time);
      return;
    }
    current = {};
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
      nextGap = time + minimumGapMs;
      if (
        !outcome.ok &&
        (outcome.error === "access_blocked" || outcome.status === 403)
      )
        blocked = true;
      else if (!outcome.ok) {
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
