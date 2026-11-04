import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const START = "<!-- supported-platforms:start -->";
const END = "<!-- supported-platforms:end -->";

export function platformList(root) {
  const manifest = JSON.parse(
    readFileSync(join(root, "packages/connectors/package.json"), "utf8"),
  );
  const directory = join(root, "packages/connectors/src/platforms");
  const lines = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })
    .filter((item) => item.isDirectory())
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const id = entry.name;
    if (id.startsWith("_")) continue;
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || !manifest.exports[`./${id}`])
      throw new Error(`Missing platform export: ${id}`);
    const index = join(directory, id, "index.ts");
    const readme = join(root, "platforms", id, "README.md");
    if (!existsSync(index) || !existsSync(readme))
      throw new Error(`Missing platform entry or README: ${id}`);
    const heading = /^#\s+(.+?)\s+(?:platform|connector)\s*$/im.exec(
      readFileSync(readme, "utf8"),
    );
    if (!heading) throw new Error(`Invalid platform README heading: ${id}`);
    lines.push(`- [${heading[1]}](platforms/${id}/README.md)`);
  }
  return lines.join("\n");
}

export function updatePlatformList(readme, list) {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (
    start < 0 ||
    end < start ||
    readme.indexOf(START, start + START.length) !== -1 ||
    readme.indexOf(END, end + END.length) !== -1
  )
    throw new Error("README must have one supported-platform marker pair");
  return `${readme.slice(0, start + START.length)}\n\n${list}\n\n${readme.slice(end)}`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const root = process.cwd();
  const path = join(root, "README.md");
  const current = readFileSync(path, "utf8");
  const updated = updatePlatformList(current, platformList(root));
  if (process.argv.includes("--check")) {
    if (current !== updated) {
      console.error(
        "Supported-platform list is stale; run npm run docs:platforms.",
      );
      process.exitCode = 1;
    }
  } else writeFileSync(path, updated);
}
