import { scanRepository } from "./no-court-data.mjs";

const findings = scanRepository(process.cwd());
if (findings.length) {
  for (const { path, reason } of findings) console.error(`${path}: ${reason}`);
  process.exitCode = 1;
} else {
  console.log("Repository text and packed package passed the data check.");
}
