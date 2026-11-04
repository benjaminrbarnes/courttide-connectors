import { copyFileSync, mkdirSync } from "node:fs";

const source = new URL(
  "../packages/connectors/schema/tenant.schema.json",
  import.meta.url,
);
const directory = new URL(
  "../packages/connectors/dist/schema/",
  import.meta.url,
);
mkdirSync(directory, { recursive: true });
copyFileSync(source, new URL("tenant.schema.json", directory));
