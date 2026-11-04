import { execFileSync } from "node:child_process";
import { lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { TextDecoder } from "node:util";

const privateReferences = [
  new RegExp(["cn", "contract"].join("-"), "i"),
  new RegExp(["cn", "discovery"].join("-"), "i"),
  new RegExp(`\\b${["C", "N"].join("")}\\d+\\b`, "i"),
];

const literalFields =
  /\b(court|courtKey|courtId|court_key|court_id|court-id|resourceId|resource_id|resource-id|externalResourceId|external_resource_id|external-resource-id|facilityId|facility_id|facility-id|rateTypeId|rate_type_id|rate-type-id|groupId|group_id|group-id|locationId|location_id|location-id|tenant|tenantKey|courttideSlug|courttide_slug|parkSlug|slug|catalogPath|basePath|detailsTextSha256)["']?\s*[:=]\s*(?:["']([^"']*)["']|(\d+)(?!\w))/gi;
const yamlFields =
  /^\s*(court|courtKey|courtId|court_key|court_id|resourceId|resource_id|externalResourceId|external_resource_id|facilityId|facility_id|rateTypeId|rate_type_id|groupId|group_id|locationId|location_id|tenant|tenantKey|courttideSlug|courttide_slug|parkSlug|slug|catalogPath|basePath|detailsTextSha256)\s*:\s*([\w./:-]+)\s*(?:#.*)?$/gim;

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    try {
      return new TextDecoder("utf-16le", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    try {
      return new TextDecoder("utf-16be", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function isExampleKey(value) {
  return (
    /^\d+(?:[:/|-]\d+)*$/.test(value) &&
    value
      .split(/[:/|-]/)
      .every(
        (part) =>
          part.length === 6 && Number(part) >= 900001 && Number(part) <= 900099,
      )
  );
}

const identifiers = new Set([
  "court",
  "courtkey",
  "courtid",
  "resourceid",
  "externalresourceid",
  "facilityid",
  "ratetypeid",
  "groupid",
  "locationid",
]);
const tenants = new Set(["example", "exampleparks", "XX/example-city"]);

function inspectField(field, value, findings, syntheticHash = false) {
  if (typeof value !== "string" && typeof value !== "number") return;
  const name = field.toLowerCase().replaceAll(/[_-]/g, "");
  const text = String(value);
  if (identifiers.has(name)) {
    if (!isExampleKey(text)) findings.add("non-example identifier");
  } else if (name === "tenant" || name === "tenantkey") {
    if (!tenants.has(text)) findings.add("non-example tenant");
  } else if (["courttideslug", "parkslug", "slug"].includes(name)) {
    if (!text.startsWith("example-")) findings.add("non-example slug");
  } else if (name === "catalogpath") {
    if (text !== "/XX/example-city/catalog")
      findings.add("non-example catalog path");
  } else if (name === "basepath") {
    if (
      !["/exampleparks", "/exampleparks/", "/XX/example-city/"].includes(text)
    )
      findings.add("non-example base path");
  } else if (
    name === "detailstextsha256" &&
    !syntheticHash &&
    !/^synthetic(?::[0-9a-f]{64})?$/.test(text)
  ) {
    findings.add("unmarked hash");
  }
}

function inspectJson(value, path, findings) {
  if (
    typeof value === "string" &&
    (value.trimStart().startsWith("{") || value.trimStart().startsWith("["))
  ) {
    try {
      inspectJson(JSON.parse(value), path, findings);
    } catch {
      /* Not an embedded JSON value. */
    }
    return;
  }
  if (typeof value === "string" && /^\s*</.test(value)) {
    for (const reason of inspectText("embedded.html", value))
      findings.add(reason);
    return;
  }
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) inspectJson(item, path, findings);
    return;
  }
  if (
    typeof value.platform === "string" &&
    typeof value.tenant === "string" &&
    Array.isArray(value.parks) &&
    !path.startsWith("examples/")
  ) {
    findings.add("configuration outside examples");
  }
  for (const [field, item] of Object.entries(value)) {
    inspectField(
      field,
      item,
      findings,
      field === "detailsTextSha256" &&
        value.detailsTextSha256Synthetic === true,
    );
    if (field === "courts" && Array.isArray(item)) {
      for (const court of item) {
        if (
          (typeof court === "string" || typeof court === "number") &&
          !isExampleKey(String(court))
        ) {
          findings.add("non-example identifier");
        }
        if (
          court &&
          typeof court === "object" &&
          "key" in court &&
          !isExampleKey(String(court.key))
        )
          findings.add("non-example identifier");
        if (
          court &&
          typeof court === "object" &&
          "id" in court &&
          !isExampleKey(String(court.id))
        ) {
          findings.add("non-example identifier");
        }
      }
    }
    if (field === "parks" && Array.isArray(item)) {
      for (const park of item) {
        if (
          park &&
          typeof park === "object" &&
          "key" in park &&
          !String(park.key).startsWith("example-")
        )
          findings.add("non-example park key");
      }
    }
    inspectJson(item, path, findings);
  }
}

function isInternalHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    host.endsWith([".up", "railway", "app"].join("."))
  )
    return true;
  if (host === "::1" || /^(?:fc|fd|fe[89ab])[0-9a-f]*:/i.test(host))
    return true;
  const parts = host.split(".");
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
  )
    return false;
  const [first, second] = parts.map(Number);
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function decodedPathParts(url, findings) {
  try {
    return url.pathname.split("/").map(decodeURIComponent);
  } catch {
    findings.add("invalid platform path");
    return [];
  }
}

function inspectYaml(text, path, findings) {
  const parents = [];
  const seen = new Set();
  for (const line of text.split(/\r?\n/)) {
    const match = /^(\s*)(?:-\s*)?([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    const field = match[2];
    let value = match[3].replace(/\s+#.*$/, "").trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    while (parents.length && parents.at(-1).indent >= indent) parents.pop();
    seen.add(field);
    if (field === "key" && value) {
      if (parents.some((parent) => parent.field === "courts")) {
        if (!isExampleKey(value)) findings.add("non-example identifier");
      } else if (
        parents.some((parent) => parent.field === "parks") &&
        !value.startsWith("example-")
      ) {
        findings.add("non-example park key");
      }
    }
    if (!value) parents.push({ indent, field });
  }
  if (
    !path.replace(/^(?:packed|staged)\//, "").startsWith("examples/") &&
    seen.has("schemaVersion") &&
    seen.has("tenant") &&
    seen.has("parks")
  ) {
    findings.add("configuration outside examples");
  }
}

export function inspectText(path, text) {
  const findings = new Set();
  if (privateReferences.some((pattern) => pattern.test(text)))
    findings.add("private planning reference");

  let data;
  if (path.endsWith(".json")) {
    try {
      data = JSON.parse(text);
      inspectJson(data, path.replace(/^(?:packed|staged)\//, ""), findings);
    } catch {
      if (/(^|\/)fixtures\//.test(path) && basename(path) === "meta.json")
        findings.add("invalid fixture metadata");
    }
  }
  if (/\.(?:ya?ml|md)$/i.test(path)) inspectYaml(text, path, findings);

  for (const match of [
    ...text.matchAll(literalFields),
    ...(/\.(?:ya?ml|md)$/i.test(path) ? text.matchAll(yamlFields) : []),
  ]) {
    const value = match[2] ?? match[3];
    if (match[1].toLowerCase() === "detailstextsha256" && data !== undefined)
      continue;
    const endOfLine = text.indexOf("\n", match.index);
    const line = text.slice(match.index, endOfLine < 0 ? undefined : endOfLine);
    const syntheticHash =
      /\.ya?ml$/i.test(path) && /\s#\s*synthetic(?:\s|$)/i.test(line);
    inspectField(match[1], value, findings, syntheticHash);
  }

  if (
    !path.replace(/^(?:packed|staged)\//, "").startsWith("examples/") &&
    /\bschemaVersion["']?\s*:\s*["']1["']/.test(text) &&
    /\btenant["']?\s*:\s*["'][^"']+["']/.test(text) &&
    /\bparks["']?\s*:\s*\[/.test(text)
  )
    findings.add("configuration outside examples");
  for (const match of text.matchAll(/\bcourts["']?\s*:\s*\[([^\]]*)\]/gs)) {
    for (const key of match[1].matchAll(/\bkey["']?\s*:\s*["']([^"']+)["']/g)) {
      if (!isExampleKey(key[1])) findings.add("non-example identifier");
    }
  }
  if (
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-(?:proj-)?[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/.test(
      text,
    )
  )
    findings.add("credential-like value");

  for (const match of text.matchAll(/https?:\/\/[^\s"'<>`)]+/gi)) {
    try {
      const url = new URL(match[0]);
      const host = url.hostname.toLowerCase();
      if (
        isInternalHost(host) ||
        (host === "courttide.com" &&
          /^\/(?:ops|admin|internal)(?:\/|$)/.test(url.pathname))
      ) {
        findings.add("internal URL");
      }
      if (
        host.endsWith("activecommunities.com") &&
        url.pathname !== "/" &&
        !/^\/(?:example|exampleparks)(?:\/|$)/.test(url.pathname)
      )
        findings.add("non-example platform path");
      if (host.endsWith("activecommunities.com")) {
        const parts = decodedPathParts(url, findings);
        const index = parts.findIndex(
          (part) => part === "daily" || part === "detail",
        );
        if (index >= 0 && !isExampleKey(parts[index + 1] ?? ""))
          findings.add("non-example identifier");
      }
      if (
        host.endsWith("rec1.com") &&
        url.pathname !== "/" &&
        !url.pathname.startsWith("/XX/example-city/") &&
        !url.pathname.startsWith("/public/")
      )
        findings.add("non-example platform path");
      if (host.endsWith("rec1.com")) {
        const parts = decodedPathParts(url, findings);
        const index = parts.findIndex((part) =>
          [
            "getFacilityHours",
            "getLocationFacilities",
            "facilityDetails",
            "getFacilityRates",
          ].includes(part),
        );
        if (index >= 0) {
          if (!(parts[index + 1] ?? "").startsWith("example"))
            findings.add("non-example session marker");
          const identifiersToCheck =
            parts[index] === "getFacilityHours" ||
            parts[index] === "getLocationFacilities"
              ? 2
              : 1;
          for (let offset = 2; offset < 2 + identifiersToCheck; offset += 1) {
            if (!isExampleKey(parts[index + offset] ?? ""))
              findings.add("non-example identifier");
          }
        }
      }
      for (const [field, value] of url.searchParams) {
        if (
          ["org", "organization"].includes(field.toLowerCase()) &&
          !tenants.has(value)
        )
          findings.add("non-example tenant");
        inspectField(field, value, findings);
      }
      if (
        host === "courttide.com" &&
        url.pathname.startsWith("/courts/") &&
        !url.pathname.slice("/courts/".length).startsWith("example-") &&
        !url.pathname.includes("%7B")
      )
        findings.add("non-example slug");
    } catch {
      // Non-URL text is handled by the other checks.
    }
  }

  if (
    /(^|\/)fixtures\//.test(path) &&
    basename(path) === "meta.json" &&
    (!data || typeof data !== "object" || data.source !== "synthetic")
  ) {
    findings.add("fixture without synthetic source");
  }
  return [...findings];
}

function inspectBytes(path, bytes, findings) {
  if (
    /(^|\/)local\//.test(path) ||
    /(^|\/)\.env[^/]*$/.test(path) ||
    path.endsWith(".har")
  ) {
    findings.push({ path, reason: "private local file" });
  }
  if (
    /(^|\/)(?:response|responses|payload|capture)\.(?:json|html|txt)$/i.test(
      path,
    ) &&
    !/(^|\/)fixtures\//.test(path)
  ) {
    findings.push({ path, reason: "fixture outside fixture directory" });
  }
  const text = decodeText(bytes);
  if (text === null) return;
  for (const reason of inspectText(path, text)) findings.push({ path, reason });
}

function inspectFixtureMetadata(files, findings) {
  for (const path of files.keys()) {
    const match = /(?:^|\/)fixtures\//.exec(path);
    if (!match || basename(path) === "meta.json") continue;
    const root = path.slice(0, match.index + match[0].length - 1);
    let directory = dirname(path);
    let metadata;
    while (
      directory.length >= root.length &&
      (directory === root || directory.startsWith(`${root}/`))
    ) {
      metadata = files.get(`${directory}/meta.json`);
      if (metadata) break;
      if (directory === root) break;
      directory = dirname(directory);
    }
    if (!metadata) {
      findings.push({ path, reason: "fixture missing synthetic metadata" });
      continue;
    }
    try {
      if (JSON.parse(metadata.toString("utf8")).source !== "synthetic")
        findings.push({ path, reason: "fixture without synthetic source" });
    } catch {
      findings.push({ path, reason: "invalid fixture metadata" });
    }
  }
}

export function scanRepository(root, packageDirectory = "packages/connectors") {
  const findings = [];
  const repositoryFiles = new Map();
  const stagedFiles = new Map();
  const indexEntries = execFileSync("git", ["ls-files", "--stage", "-z"], {
    cwd: root,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((entry) => /^(\d{6}) ([0-9a-f]+) (\d)\t([\s\S]+)$/.exec(entry));
  const tracked = new Set();
  for (const entry of indexEntries) {
    if (!entry) throw new Error("Unable to inspect the Git index");
    const [, mode, object, stage, path] = entry;
    tracked.add(path);
    if (stage !== "0") findings.push({ path, reason: "unmerged index entry" });
    if (mode === "120000")
      findings.push({ path, reason: "tracked symbolic link" });
    if (mode === "160000") {
      findings.push({ path, reason: "tracked submodule" });
      continue;
    }
    const bytes = execFileSync("git", ["cat-file", "blob", object], {
      cwd: root,
      maxBuffer: 100 * 1024 * 1024,
    });
    stagedFiles.set(`staged/${path}`, bytes);
    inspectBytes(`staged/${path}`, bytes, findings);
  }
  inspectFixtureMetadata(stagedFiles, findings);
  const untracked = execFileSync(
    "git",
    ["ls-files", "--others", "--exclude-standard", "-z"],
    { cwd: root },
  )
    .toString("utf8")
    .split("\0")
    .filter(Boolean);

  for (const path of new Set([...tracked, ...untracked])) {
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
      const bytes = readFileSync(join(root, path));
      repositoryFiles.set(path, bytes);
      inspectBytes(path, bytes, findings);
    }
  }
  inspectFixtureMetadata(repositoryFiles, findings);

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
    const packedFiles = new Map();
    for (const file of result[0].files) {
      const path = `packed/${file.path}`;
      const bytes = execFileSync(
        "tar",
        ["-xOf", archive, `package/${file.path}`],
        { maxBuffer: 100 * 1024 * 1024 },
      );
      packedFiles.set(path, bytes);
      inspectBytes(path, bytes, findings);
    }
    inspectFixtureMetadata(packedFiles, findings);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return findings;
}
