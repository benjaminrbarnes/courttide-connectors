import { mkdirSync, writeFileSync } from "node:fs";
import prettier from "prettier";
import { z } from "zod";
import { TenantConfigSchema } from "../packages/connectors/dist/index.js";

const schema = await prettier.format(
  JSON.stringify(z.toJSONSchema(TenantConfigSchema, { io: "input" })),
  { parser: "json" },
);
for (const directory of ["schema", "packages/connectors/schema"]) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(`${directory}/tenant.schema.json`, schema);
}
