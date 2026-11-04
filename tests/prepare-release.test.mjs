import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { validateRelease } from "../scripts/prepare-release.mjs";

it("binds the tag, package bytes and versioned release notes", () => {
  const bytes = Buffer.from("synthetic package");
  const manifest = {
    name: "@courttide/connectors",
    version: "0.1.0",
    files: ["dist"],
    peerDependencies: { zod: "4.6.7", "@js-temporal/polyfill": "0.5.1" },
    bin: { "courttide-connectors": "./dist/cli/main.js" },
    exports: {
      "./activenet": {},
      "./civicrec": {},
      "./schema/tenant.schema.json": "./dist/schema/tenant.schema.json",
    },
  };
  const metadata = [
    {
      name: manifest.name,
      version: manifest.version,
      filename: "courttide-connectors-0.1.0.tgz",
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    },
  ];
  const changelog =
    "# Changelog\n\n## 0.1.0\n\n- Synthetic change.\n\n## 0.0.9\n\n- Earlier change.\n";
  const result = validateRelease(
    "connectors-v0.1.0",
    manifest,
    metadata,
    bytes,
    changelog,
  );
  expect(result.notes).toBe("## 0.1.0\n\n- Synthetic change.\n");
  expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(() =>
    validateRelease("connectors-v0.1.1", manifest, metadata, bytes, changelog),
  ).toThrow("tag");
  expect(() =>
    validateRelease(
      "connectors-v0.1.0",
      manifest,
      metadata,
      Buffer.from("changed"),
      changelog,
    ),
  ).toThrow("integrity");
  expect(() =>
    validateRelease(
      "connectors-v0.1.0",
      manifest,
      [{ ...metadata[0], filename: "../example.tgz" }],
      bytes,
      changelog,
    ),
  ).toThrow("metadata");
  expect(() =>
    validateRelease(
      "connectors-v0.1.0",
      manifest,
      metadata,
      bytes,
      "# Changelog\n",
    ),
  ).toThrow("notes");
  expect(() =>
    validateRelease(
      "connectors-v0.1.0",
      { ...manifest, bin: undefined },
      metadata,
      bytes,
      changelog,
    ),
  ).toThrow("not ready");
  expect(() =>
    validateRelease(
      "connectors-v0.1.0",
      { ...manifest, scripts: { postinstall: "example" } },
      metadata,
      bytes,
      changelog,
    ),
  ).toThrow("not ready");
});
