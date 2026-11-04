import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import {
  CONFORMANCE_CASES,
  runConformance,
} from "../packages/connectors/src/testing/index.js";
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

it("replays distinct response and final observation times", async () => {
  const root = mkdtempSync(join(tmpdir(), "connector-fixture-"));
  try {
    const directory = join(root, "open");
    cpSync("platforms/civicrec/fixtures/open", directory, { recursive: true });
    const metaPath = join(directory, "meta.json");
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    meta.configPath = resolve("examples/tenants/civicrec.json");
    meta.clockSequence = [
      "2026-11-04T12:00:00.000Z",
      "2026-11-04T12:00:12.000Z",
      "2026-11-04T12:00:13.000Z",
    ];
    writeFileSync(metaPath, JSON.stringify(meta));
    const outputPath = join(directory, "expected.json");
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    output.days[0].observedAt = "2026-11-04T12:00:12Z";
    output.observedAt = "2026-11-04T12:00:13.000Z";
    writeFileSync(outputPath, JSON.stringify(output));
    const inapplicableCases = Object.fromEntries(
      CONFORMANCE_CASES.filter((name) => name !== "open_interval").map(
        (name) => [name, "This fixture exercises one synthetic read."],
      ),
    );
    await expect(
      runConformance(civicRecPlatform, root, { inapplicableCases }),
    ).resolves.toEqual({ fixtures: 1, cases: ["open_interval"] });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
