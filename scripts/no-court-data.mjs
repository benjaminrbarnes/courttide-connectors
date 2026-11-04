import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { TextDecoder } from "node:util";

const privateReferences = [
  new RegExp(["cn", "contract"].join("-"), "i"),
  new RegExp(["cn", "discovery"].join("-"), "i"),
  new RegExp(`\\b${["C", "N"].join("")}\\d+\\b`, "i"),
];

const literalFields =
  /\b(courtKey|courtId|court_key|court_id|facilityId|facility_id|rateTypeId|rate_type_id|groupId|group_id|locationId|location_id|tenant|courttideSlug|slug|catalogPath)["']?\s*[:=]\s*(?:["']([^"']*)["']|(\d+))/gi;
const yamlFields =
  /^\s*(courtKey|courtId|court_key|court_id|facilityId|facility_id|rateTypeId|rate_type_id|groupId|group_id|locationId|location_id|tenant|courttideSlug|slug|catalogPath)\s*:\s*([\w./-]+)\s*(?:#.*)?$/gim;

function decodeText(bytes) {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isExampleKey(value) {
  return (
    /^\d+$/.test(value) && Number(value) >= 900001 && Number(value) <= 900099
  );
}

export function inspectText(path, text) {
  const findings = new Set();
  if (privateReferences.some((pattern) => pattern.test(text)))
    findings.add("private planning reference");

  for (const match of [
    ...text.matchAll(literalFields),
    ...text.matchAll(yamlFields),
  ]) {
    const field = match[1].toLowerCase();
    const value = match[2] ?? match[3];
    if (field === "tenant") {
      if (!["example", "exampleparks", "XX/example-city"].includes(value))
        findings.add("non-example tenant");
    } else if (field === "courttideslug" || field === "slug") {
      if (!value.startsWith("example-")) findings.add("non-example slug");
    } else if (field === "catalogpath") {
      if (value !== "/XX/example-city/catalog")
        findings.add("non-example catalog path");
    } else if (!isExampleKey(value)) {
      findings.add("non-example identifier");
    }
  }

  for (const match of text.matchAll(/https?:\/\/[^\s"'<>`)]+/gi)) {
    try {
      const host = new URL(match[0]).hostname.toLowerCase();
      if (
        host === "localhost" ||
        host.endsWith(".internal") ||
        host.endsWith([".up", "railway", "app"].join("."))
      ) {
        findings.add("internal URL");
      }
    } catch {
      // Non-URL text is handled by the other checks.
    }
  }

  if (path.endsWith(".json")) {
    try {
      const data = JSON.parse(text);
      if (
        data &&
        typeof data === "object" &&
        typeof data.platform === "string" &&
        typeof data.tenant === "string" &&
        Array.isArray(data.parks) &&
        !path.startsWith("examples/")
      ) {
        findings.add("configuration outside examples");
      }
      if (data && typeof data === "object" && Array.isArray(data.parks)) {
        for (const park of data.parks) {
          if (!park || !Array.isArray(park.courts)) continue;
          for (const court of park.courts) {
            if (
              court &&
              typeof court === "object" &&
              "key" in court &&
              !isExampleKey(String(court.key))
            ) {
              findings.add("non-example identifier");
            }
          }
        }
      }
      if (
        /(^|\/)fixtures\//.test(path) &&
        basename(path) === "meta.json" &&
        (!data || typeof data !== "object" || data.source !== "synthetic")
      ) {
        findings.add("fixture without synthetic source");
      }
    } catch {
      // Source and documentation can contain JSON fragments rather than JSON files.
    }
  }
  return [...findings];
}

function inspectBytes(path, bytes, findings) {
  const text = decodeText(bytes);
  if (text === null) return;
  for (const reason of inspectText(path, text)) findings.push({ path, reason });
}

export function scanRepository(root, packageDirectory = "packages/connectors") {
  const findings = [];
  const paths = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);

  for (const path of new Set(paths)) {
    if (
      /(^|\/)local\//.test(path) ||
      /(^|\/)\.env[^/]*$/.test(path) ||
      path.endsWith(".har")
    ) {
      findings.push({ path, reason: "private local file" });
    }
    let stats;
    try {
      stats = lstatSync(join(root, path));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (stats.isSymbolicLink()) {
      findings.push({ path, reason: "tracked symbolic link" });
    } else if (stats.isFile()) {
      inspectBytes(path, readFileSync(join(root, path)), findings);
    }
  }

  const temporary = mkdtempSync(join(tmpdir(), "connectors-pack-"));
  try {
    const result = JSON.parse(
      execFileSync(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
        {
          cwd: join(root, packageDirectory),
          encoding: "utf8",
        },
      ),
    );
    if (result.length !== 1)
      throw new Error("Expected exactly one packed package");
    const archive = join(temporary, result[0].filename);
    for (const file of result[0].files) {
      const path = `packed/${file.path}`;
      const bytes = execFileSync(
        "tar",
        ["-xOf", archive, `package/${file.path}`],
        { maxBuffer: 100 * 1024 * 1024 },
      );
      inspectBytes(path, bytes, findings);
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return findings;
}
