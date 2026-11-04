import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inspectText, scanRepository } from "../scripts/no-court-data.mjs";

const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("repository data check", () => {
  it("allows synthetic identifiers and detects a planted configuration", () => {
    const example = {
      tenant: "example",
      courtKey: 900001,
      courttideSlug: "example-park",
    };
    expect(
      inspectText("examples/tenants/example.json", JSON.stringify(example)),
    ).toEqual([]);
    expect(
      inspectText(
        "examples/tenants/example.json",
        JSON.stringify({ ...example, tenant: "exampleparks" }),
      ),
    ).toEqual([]);

    const planted = {
      ...example,
      platform: "example",
      tenant: ["not", "example"].join("-"),
      courtKey: example.courtKey - 1,
      parks: [],
    };
    expect(inspectText("docs/sample.json", JSON.stringify(planted))).toEqual(
      expect.arrayContaining([
        "non-example tenant",
        "non-example identifier",
        "configuration outside examples",
      ]),
    );
  });

  it("rejects private planning references and non-synthetic fixture metadata", () => {
    expect(inspectText("docs/example.md", ["C", "N", 12].join(""))).toContain(
      "private planning reference",
    );
    expect(
      inspectText(
        "fixtures/example/meta.json",
        JSON.stringify({ source: "recorded" }),
      ),
    ).toContain("fixture without synthetic source");
  });

  it("finds unquoted fields and nested identifiers without treating numeric bounds as data", () => {
    const exampleKey = 900001;
    const invalid = exampleKey - 1;
    const yaml = [
      ["tenant", ": ", ["not", "example"].join("-")].join(""),
      `facility_id: ${invalid}`,
    ].join("\n");
    expect(inspectText("docs/example.yaml", yaml)).toEqual(
      expect.arrayContaining(["non-example tenant", "non-example identifier"]),
    );
    const config = {
      tenant: "example",
      parks: [{ courts: [{ key: String(invalid) }] }],
    };
    expect(
      inspectText("examples/tenants/example.json", JSON.stringify(config)),
    ).toContain("non-example identifier");
    expect(
      inspectText("docs/schema.ts", "const minimum = 1; const maximum = 256;"),
    ).toEqual([]);
  });

  it("scans tracked text and an ignored file that is included in the packed package", () => {
    const root = mkdtempSync(join(tmpdir(), "connectors-check-"));
    temporary.push(root);
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, ".gitignore"), "dist/\n");
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "example-package",
        version: "0.0.0",
        files: ["dist"],
      }),
    );
    const planted = JSON.stringify({ facilityId: 900099 + 1 });
    writeFileSync(join(root, "README.md"), planted);
    writeFileSync(
      join(root, "dist", "index.js"),
      `export default ${planted};\n`,
    );
    execFileSync("git", ["add", ".gitignore", "package.json", "README.md"], {
      cwd: root,
    });

    const findings = scanRepository(root, ".");
    expect(findings).toContainEqual({
      path: "README.md",
      reason: "non-example identifier",
    });
    expect(findings).toContainEqual({
      path: "packed/dist/index.js",
      reason: "non-example identifier",
    });
  });
});
