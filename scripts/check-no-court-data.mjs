import { scanRepository } from "./no-court-data.mjs";

if (process.argv.length > 3)
  throw new Error("Expected at most one package archive");
const findings = scanRepository(process.cwd(), undefined, process.argv[2]);
if (findings.length) {
  for (const { path, reason } of findings) console.error(`${path}: ${reason}`);
  process.exitCode = 1;
} else {
  console.log("Repository text and packed package passed the data check.");
}
