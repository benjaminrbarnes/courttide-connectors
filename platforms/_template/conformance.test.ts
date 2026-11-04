import { expect, it } from "vitest";
import {
  CONFORMANCE_CASES,
  runConformance,
} from "../../packages/connectors/src/testing/index.js";
import { examplePlatform } from "./index.js";

it("runs the synthetic teaching fixture", async () => {
  const inapplicableCases = Object.fromEntries(
    CONFORMANCE_CASES.filter((name) => name !== "open_interval").map((name) => [
      name,
      "Teaching template only; replace this placeholder for a real platform.",
    ]),
  );
  const result = await runConformance(
    examplePlatform,
    "platforms/_template/fixtures",
    { inapplicableCases },
  );
  expect(result.cases).toEqual(["open_interval"]);
});
