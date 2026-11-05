export const CONTRACT_VERSION = "1" as const;
export const MINIMUM_DEVELOPMENT_GAP_MS = 2_000;
export const DEFAULT_DEVELOPMENT_GAP_MS = 2_500;
export const ATTRIBUTION = {
  text: "Read with courttide-connectors by CourtTide",
  url: "https://courttide.com",
} as const;

export const ACTIVENET_REASON_CODES = [
  "source_hidden_or_unavailable",
  "occupancy_unknown",
  "source_schedule_closed",
  "source_fully_booked",
  "source_closes_at_midnight",
  "unknown_source_status",
  "unsupported_check_mode",
  "duplicate_source_date",
  "date_out_of_range",
  "date_coverage_incomplete",
  "range_incomplete",
] as const;

export const CIVICREC_ISSUE_CODES = [
  "invalid_request_context",
  "invalid_payload",
  "hours_missing_or_invalid",
  "display_hours_missing_or_invalid",
  "empty_hours",
  "empty_display_hours",
  "range_limit_exceeded",
  "invalid_range_shape",
  "nonpositive_range",
  "unsupported_cross_date_range",
  "invalid_epoch",
  "invalid_local_time",
  "epoch_local_mismatch",
  "date_mismatch",
  "rate_mismatch",
  "display_hours_conflict",
  "invalid_signal",
  "text_limit_exceeded",
] as const;

export const CIVICREC_REASON_ORDER = {
  first: "reported_ranges_only",
  issues: CIVICREC_ISSUE_CODES,
  hidden: "source_hidden_or_unavailable",
  unusable: "occupancy_unknown",
} as const;

export const RESERVED_REASON_CODES = [
  "reported_starts_only",
  "reported_reservations_only",
] as const;
