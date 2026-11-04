import { expect, it } from "vitest";
import {
  parseCivicrecHours,
  type CivicrecHoursContext,
  type CivicrecHoursEvidence,
} from "../packages/connectors/src/testing/index.js";

it("exposes parser-only invalid cases through the testing entrypoint", () => {
  const context: CivicrecHoursContext = {
    facilityId: "900003",
    rateTypeId: "900004",
    date: "2026-11-04",
    timeZone: "UTC",
  };
  const invalidPayload: CivicrecHoursEvidence = parseCivicrecHours(
    null,
    context,
  );
  expect(invalidPayload).toMatchObject({
    kind: "invalid",
    issues: ["invalid_payload"],
  });
  const invalidContext = parseCivicrecHours(
    {},
    { ...context, date: "2026-02-30" },
  );
  expect(invalidContext).toMatchObject({
    kind: "invalid",
    issues: ["invalid_request_context"],
  });
});
