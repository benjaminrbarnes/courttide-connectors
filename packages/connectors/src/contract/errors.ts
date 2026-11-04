import type { ConnectorErrorCode, Instant } from "./types.js";

export class ConnectorError extends Error {
  override name = "ConnectorError";
  constructor(
    public code: ConnectorErrorCode,
    public retryable = false,
    public retryAfterMs: number | null = null,
  ) {
    super(code);
  }
}

export class GateDeferred extends Error {
  override name = "GateDeferred";
  constructor(
    public until: Instant,
    public reason: "hold" | "pacing" | "budget",
  ) {
    super("gate_deferred");
  }
}
