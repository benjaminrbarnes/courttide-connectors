import { expect, it } from "vitest";
import { runConformance } from "../packages/connectors/src/testing/index.js";
import { civicRecPlatform } from "../packages/connectors/src/platforms/civicrec/index.js";

it("passes the synthetic CivicRec conformance matrix", async () => {
  const result = await runConformance(
    civicRecPlatform,
    "platforms/civicrec/fixtures",
    {
      inapplicableCases: {
        explicit_taken_interval:
          "The endpoint reports positive ranges only and does not assert taken intervals.",
        whole_day_closed: "The endpoint has no whole-day closed status.",
        whole_day_booked: "The endpoint has no whole-day booked status.",
        unknown_status:
          "The endpoint has no status enumeration; malformed eligibility signals are covered by parser tests.",
        wrong_id:
          "The hours response does not echo a facility identifier and identity mode is none.",
        missing_date:
          "Each requested date has its own response rather than a list of date rows.",
        duplicate_date:
          "Each requested date has its own response rather than a list of date rows.",
        instruction_like_label:
          "The hours response has no court label and configured labels are not read or returned.",
      },
    },
  );
  expect(result.fixtures).toBeGreaterThan(20);
});
