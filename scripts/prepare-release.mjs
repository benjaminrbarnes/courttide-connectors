import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function validateRelease(tag, manifest, metadata, bytes, changelog) {
  if (
    !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(
      manifest.version,
    ) ||
    tag !== `connectors-v${manifest.version}` ||
    manifest.name !== "@courttide/connectors"
  )
    throw new Error("Release tag does not match the package version");
  if (
    JSON.stringify(manifest.files) !== JSON.stringify(["dist"]) ||
    manifest.peerDependencies?.zod !== "4.6.7" ||
    manifest.peerDependencies?.["@js-temporal/polyfill"] !== "0.5.1" ||
    manifest.bin?.["courttide-connectors"] !== "./dist/cli/main.js" ||
    !manifest.exports?.["./activenet"] ||
    !manifest.exports?.["./civicrec"] ||
    !manifest.exports?.["./schema/tenant.schema.json"] ||
    [
      "preinstall",
      "install",
      "postinstall",
      "prepare",
      "prepack",
      "postpack",
      "prepublish",
      "prepublishOnly",
    ].some((name) => Object.hasOwn(manifest.scripts ?? {}, name))
  )
    throw new Error("Package is not ready for release");
  if (
    !Array.isArray(metadata) ||
    metadata.length !== 1 ||
    metadata[0].name !== manifest.name ||
    metadata[0].version !== manifest.version ||
    metadata[0].filename !== `courttide-connectors-${manifest.version}.tgz`
  )
    throw new Error("Invalid package metadata");
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (metadata[0].integrity !== integrity)
    throw new Error("Package integrity mismatch");
  const heading = `## ${manifest.version}`;
  const sections = changelog.split(/(?=^## )/m);
  const section = sections.find(
    (part) => part.split("\n", 1)[0].trim() === heading,
  );
  if (!section || !section.slice(heading.length).trim())
    throw new Error("Missing release notes for version");
  return {
    filename: metadata[0].filename,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity,
    notes: section.trim() + "\n",
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const [tag, metadataPath, directory] = process.argv.slice(2);
  if (!tag || !metadataPath || !directory || process.argv.length !== 5)
    throw new Error(
      "Expected a tag, package metadata file and artifact directory",
    );
  const manifest = JSON.parse(
    readFileSync("packages/connectors/package.json", "utf8"),
  );
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (
    !Array.isArray(metadata) ||
    metadata.length !== 1 ||
    typeof metadata[0].filename !== "string" ||
    !/^courttide-connectors-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.tgz$/.test(
      metadata[0].filename,
    ) ||
    metadata[0].filename !== `courttide-connectors-${manifest.version}.tgz`
  )
    throw new Error("Invalid package metadata");
  const bytes = readFileSync(join(directory, metadata[0].filename));
  const result = validateRelease(
    tag,
    manifest,
    metadata,
    bytes,
    readFileSync("CHANGELOG.md", "utf8"),
  );
  writeFileSync(
    join(directory, "SHA256SUMS.txt"),
    `${result.sha256}  ${result.filename}\n`,
  );
  writeFileSync(
    join(directory, "INTEGRITY.txt"),
    `${result.integrity}  ${result.filename}\n`,
  );
  writeFileSync(join(directory, "RELEASE-NOTES.md"), result.notes);
}
