import { resolve } from "node:path";
import { runConformance } from "../../packages/connectors/src/testing/conformance.js";
import { activeNetPlatform } from "../../packages/connectors/src/platforms/activenet/index.js";
import { describe, expect, it } from "vitest";

describe("ActiveNet conformance fixtures", () => {
  it("matches synthetic request, gate, parser and output goldens", async () => {
    const result = await runConformance(
      activeNetPlatform,
      resolve("examples/activenet/fixtures/cases"),
      {
        inapplicableCases: {
          challenge:
            "The ActiveNet transport profile has no challenge detector; HTML is rejected by its JSON-only content-type rule.",
          passive_challenge_asset:
            "The ActiveNet transport profile has no passive challenge assets.",
          missing_token: "ActiveNet does not bootstrap or use a session token.",
          bad_cookie: "ActiveNet does not bootstrap or use a cookie jar.",
          expired_session:
            "ActiveNet has no session bootstrap or expiry state.",
          cached_bootstrap_failure:
            "ActiveNet does not bootstrap or cache a session.",
        },
      },
    );
    expect(result.fixtures).toBeGreaterThan(0);
    expect(result.cases).toContain("midnight_end");
    expect(result.cases).toContain("fall_back_ambiguity");
    expect(result.cases).toContain("timeout_during_body");
  });
});
