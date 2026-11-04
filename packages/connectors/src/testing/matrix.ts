export const CONFORMANCE_CASES = [
  "open_interval",
  "explicit_taken_interval",
  "gap",
  "touching_intervals",
  "whole_day_closed",
  "whole_day_booked",
  "hidden_day",
  "unknown_status",
  "wrong_id",
  "missing_date",
  "duplicate_date",
  "out_of_range_date",
  "valid_dst_day",
  "spring_forward_gap",
  "fall_back_ambiguity",
  "midnight_end",
  "cross_day",
  "court_outside_allowlist",
  "bad_date_range",
  "rate_limit_seconds",
  "rate_limit_date",
  "rate_limit_without_retry",
  "server_error",
  "timeout_before_body",
  "timeout_during_body",
  "redirect",
  "unauthorized",
  "forbidden",
  "html_instead_of_json",
  "challenge",
  "passive_challenge_asset",
  "oversize_body",
  "oversize_html",
  "malformed_json",
  "no_body",
  "application_error",
  "instruction_like_label",
  "missing_token",
  "bad_cookie",
  "expired_session",
  "cached_bootstrap_failure",
] as const;

export function assertCaseMatrix(
  cases: readonly string[],
  inapplicable: Readonly<Record<string, string>> = {},
): void {
  const known = new Set<string>(CONFORMANCE_CASES);
  for (const value of cases)
    if (!known.has(value)) throw new Error("Unknown conformance case");
  for (const [name, reason] of Object.entries(inapplicable)) {
    if (!known.has(name) || !reason.trim() || cases.includes(name))
      throw new Error("Invalid inapplicable conformance case");
  }
  for (const name of CONFORMANCE_CASES) {
    if (!cases.includes(name) && !(name in inapplicable))
      throw new Error(`Missing conformance case: ${name}`);
  }
}
