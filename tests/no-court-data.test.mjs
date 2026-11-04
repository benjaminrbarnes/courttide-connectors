import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  inspectText,
  isInternalHost,
  scanPackedArchive,
  scanRepository,
} from "../scripts/no-court-data.mjs";

const temporary = [];
afterEach(() => {
  for (const path of temporary.splice(0))
    rmSync(path, { recursive: true, force: true });
});

describe("repository data check", () => {
  it("scans the exact archive even when its source later changes", () => {
    const root = mkdtempSync(join(tmpdir(), "connectors-archive-"));
    temporary.push(root);
    mkdirSync(join(root, "package", "dist"), { recursive: true });
    const source = join(root, "package", "dist", "index.js");
    const planted = JSON.stringify({ facilityId: 900099 + 1 });
    writeFileSync(source, `export default ${planted};\n`);
    const archive = join(root, "example.tgz");
    execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
    writeFileSync(source, "export default {};\n");
    expect(scanPackedArchive(archive)).toContainEqual({
      path: "packed/dist/index.js",
      reason: "non-example identifier",
    });
  });

  it("rejects links in a packed archive", () => {
    const root = mkdtempSync(join(tmpdir(), "connectors-archive-"));
    temporary.push(root);
    mkdirSync(join(root, "package", "dist"), { recursive: true });
    symlinkSync("target", join(root, "package", "dist", "link"));
    const archive = join(root, "example.tgz");
    execFileSync("tar", ["-czf", archive, "-C", root, "package"]);
    expect(scanPackedArchive(archive)).toContainEqual({
      path: "packed/dist/link",
      reason: "non-regular archive entry",
    });
  });
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
      inspectText(
        "docs/example.json",
        JSON.stringify({ courts: [String(invalid)] }),
      ),
    ).toContain("non-example identifier");
    const embedded = JSON.stringify({
      body: JSON.stringify({ resource_id: invalid }),
    });
    expect(inspectText("fixtures/example/response.json", embedded)).toContain(
      "non-example identifier",
    );
    const htmlBody = [
      "<div data-",
      "facility",
      "-id=",
      '"',
      invalid,
      '"',
      "></div>",
    ].join("");
    const html = JSON.stringify({ body: htmlBody });
    expect(inspectText("fixtures/example/response.json", html)).toContain(
      "non-example identifier",
    );
    expect(
      inspectText("docs/schema.ts", "const minimum = 1; const maximum = 256;"),
    ).toEqual([]);
    const yamlConfig = [
      `${["schema", "Version"].join("")}: '1'`,
      "platform: example",
      ["tenant", ": exampleparks"].join(""),
      "parks:",
      "  - key: example-park",
      "    courts:",
      `      - key: ${invalid}`,
    ].join("\n");
    expect(inspectText("examples/tenants/example.yaml", yamlConfig)).toContain(
      "non-example identifier",
    );
    expect(inspectText("docs/example.yaml", yamlConfig)).toContain(
      "configuration outside examples",
    );
  });

  it("checks composite keys, platform paths, slugs and explicitly marked synthetic hashes", () => {
    const exampleKey = 900001;
    const invalid = exampleKey - 1;
    const hashField = ["details", "TextSha256"].join("");
    const hash = "a".repeat(64);
    const safe = {
      tenant: "exampleparks",
      courtKey: `${exampleKey}:${exampleKey + 1}`,
      catalogPath: "/XX/example-city/catalog",
      [hashField]: hash,
      [`${hashField}Synthetic`]: true,
    };
    expect(
      inspectText("examples/tenants/example.json", JSON.stringify(safe)),
    ).toEqual([]);
    const bad = {
      ...safe,
      courtKey: `${exampleKey}:${invalid}`,
      slug: ["not", "example"].join("-"),
      [`${hashField}Synthetic`]: false,
    };
    expect(
      inspectText("examples/tenants/example.json", JSON.stringify(bad)),
    ).toEqual(
      expect.arrayContaining([
        "non-example identifier",
        "non-example slug",
        "unmarked hash",
      ]),
    );
    const yamlHash = [hashField, ": ", hash].join("");
    expect(
      inspectText("examples/tenants/example.yaml", `${yamlHash} # synthetic`),
    ).toEqual([]);
    expect(inspectText("examples/tenants/example.yaml", yamlHash)).toContain(
      "unmarked hash",
    );
    expect(
      inspectText(
        "docs/sample.json",
        JSON.stringify({ courtKey: `0${exampleKey}` }),
      ),
    ).toContain("non-example identifier");
    const host = ["example", "activecommunities", "com"].join(".");
    const url = new URL(
      `/${["not", "example"].join("-")}/rest`,
      ["https:", "", host].join("/"),
    );
    expect(inspectText("docs/sample.md", String(url))).toContain(
      "non-example platform path",
    );
    const otherHost = ["secure", "rec1", "com"].join(".");
    const path = [
      "",
      "XX",
      "example-city",
      "catalog",
      "getFacilityHours",
      "example-session",
      invalid,
      exampleKey,
      "2026-11-04",
    ].join("/");
    const otherUrl = new URL(path, ["https:", "", otherHost].join("/"));
    expect(inspectText("docs/sample.md", String(otherUrl))).toContain(
      "non-example identifier",
    );
  });

  it("allows generic loopback URLs and still blocks private hosts", () => {
    for (const url of [
      "http://localhost:3000/",
      "http://127.0.0.1:3000/",
      "http://127.42.0.2:3000/",
      "http://[::1]:3000/",
      "http://[::ffff:127.0.0.1]:3000/",
    ]) {
      expect(inspectText("docs/sample.md", url)).not.toContain("internal URL");
    }
    for (const host of [
      "example.internal",
      "example.up.railway.app",
      "10.0.0.42",
      "172.16.0.42",
      "172.31.0.42",
      "192.168.1.42",
      "169.254.0.42",
      "::ffff:0a00:2a",
    ]) {
      expect(isInternalHost(host)).toBe(true);
    }
  });

  it("finds private references without embedding them as text", () => {
    const reference = ["cn", "contract"].join("-");
    expect(inspectText("docs/sample.md", reference)).toContain(
      "private planning reference",
    );
  });

  // This case runs multiple npm pack subprocesses and can exceed the default
  // timeout when the machine is busy.
  it("scans tracked text and an ignored file that is included in the packed package", () => {
    const root = mkdtempSync(join(tmpdir(), "connectors-check-"));
    temporary.push(root);
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, "dist"));
    mkdirSync(join(root, "dist", "fixtures", "example"), { recursive: true });
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
    writeFileSync(join(root, "response.json"), "{}");
    writeFileSync(
      join(root, "dist", "index.js"),
      `export default ${planted};\n`,
    );
    writeFileSync(
      join(root, "dist", "fixtures", "example", "response.json"),
      "{}",
    );
    execFileSync(
      "git",
      ["add", ".gitignore", "package.json", "README.md", "response.json"],
      {
        cwd: root,
      },
    );

    const findings = scanRepository(root, ".");
    expect(findings).toContainEqual({
      path: "README.md",
      reason: "non-example identifier",
    });
    expect(findings).toContainEqual({
      path: "response.json",
      reason: "fixture outside fixture directory",
    });
    expect(findings).toContainEqual({
      path: "packed/dist/index.js",
      reason: "non-example identifier",
    });
    expect(findings).toContainEqual({
      path: "packed/dist/fixtures/example/response.json",
      reason: "fixture missing synthetic metadata",
    });
    writeFileSync(
      join(root, "dist", "fixtures", "example", "meta.json"),
      JSON.stringify({ source: "synthetic" }),
    );
    expect(scanRepository(root, ".")).not.toContainEqual({
      path: "packed/dist/fixtures/example/response.json",
      reason: "fixture missing synthetic metadata",
    });
    writeFileSync(join(root, "README.md"), "safe");
    const unicode = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(planted, "utf16le"),
    ]);
    writeFileSync(join(root, "unicode.txt"), unicode);
    execFileSync("git", ["add", "unicode.txt"], { cwd: root });
    const stagedFindings = scanRepository(root, ".");
    expect(stagedFindings).toContainEqual({
      path: "staged/README.md",
      reason: "non-example identifier",
    });
    expect(stagedFindings).toContainEqual({
      path: "unicode.txt",
      reason: "non-example identifier",
    });
  }, 20000);
});
