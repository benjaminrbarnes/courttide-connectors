import type { ConnectorErrorCode, Instant } from "./types.js";

export const CONNECTOR_REJECTION_REASONS = Object.freeze([
  "bootstrap_content_type",
  "transport_redirect",
  "transport_redirect_header",
  "transport_auth_status",
  "transport_content_type",
  "transport_challenge",
  "transport_json_html",
  "transport_application_error",
  "bootstrap_response_invalid",
  "bootstrap_chronology",
  "bootstrap_context_invalid",
  "bootstrap_attributes_invalid",
  "bootstrap_json_invalid",
  "bootstrap_checkout_invalid",
  "cookie_domain",
  "cookie_path_invalid",
  "cookie_path_mismatch",
  "cookie_partitioned",
  "cookie_secure_prefix",
  "cookie_host_prefix",
  "cookie_none_applicable",
  "cookie_received_at",
  "cookie_missing",
  "cookie_rows_limit",
  "cookie_bytes_limit",
  "cookie_pair_invalid",
  "cookie_name_invalid",
  "cookie_value_invalid",
  "cookie_name_duplicate",
  "cookie_attribute_duplicate",
  "cookie_secure_attribute",
  "cookie_max_age",
  "cookie_expires",
] as const);

export type ConnectorRejectionReason =
  (typeof CONNECTOR_REJECTION_REASONS)[number];

export function isConnectorRejectionReason(
  value: unknown,
): value is ConnectorRejectionReason {
  return (
    typeof value === "string" &&
    CONNECTOR_REJECTION_REASONS.some((reason) => reason === value)
  );
}

export class ConnectorError extends Error {
  override name = "ConnectorError";
  readonly rejectionReason?: ConnectorRejectionReason;
  constructor(
    public code: ConnectorErrorCode,
    public retryable = false,
    public retryAfterMs: number | null = null,
    rejectionReason?: ConnectorRejectionReason,
  ) {
    super(code);
    if (isConnectorRejectionReason(rejectionReason))
      this.rejectionReason = rejectionReason;
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
