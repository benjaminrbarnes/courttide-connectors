import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { platformList, updatePlatformList } from "../scripts/platform-list.mjs";

let root;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});
it("generates a deterministic list from platform exports and headings", () => {
  root = mkdtempSync(join(tmpdir(), "example-platform-list-"));
  mkdirSync(join(root, "packages/connectors/src/platforms/example"), {
    recursive: true,
  });
  mkdirSync(join(root, "platforms/example"), { recursive: true });
  writeFileSync(
    join(root, "packages/connectors/package.json"),
    JSON.stringify({ exports: { "./example": "./dist/example.js" } }),
  );
  writeFileSync(
    join(root, "packages/connectors/src/platforms/example/index.ts"),
    "export {};\n",
  );
  writeFileSync(
    join(root, "platforms/example/README.md"),
    "# Example Platform connector\n",
  );
  const list = platformList(root);
  expect(list).toBe("- [Example Platform](platforms/example/README.md)");
  const before =
    "# Example\n\n<!-- supported-platforms:start -->\nold\n<!-- supported-platforms:end -->\n";
  const after = updatePlatformList(before, list);
  expect(after).toContain(list);
  expect(updatePlatformList(after, list)).toBe(after);
  expect(() => updatePlatformList("missing markers", list)).toThrow();
  writeFileSync(
    join(root, "packages/connectors/package.json"),
    JSON.stringify({ exports: {} }),
  );
  expect(() => platformList(root)).toThrow("Missing platform export");
});
