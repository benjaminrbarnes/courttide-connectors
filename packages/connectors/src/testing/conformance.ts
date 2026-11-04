import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  CapabilitiesSchema,
  InstantSchema,
  TenantConfigSchema,
} from "../contract/schemas.js";
import type {
  Gate,
  HttpClient,
  Platform,
  TenantConfig,
} from "../contract/types.js";
import { validateCourtReading } from "../contract/validation.js";
import { createFakeFetch, createRecordingGate, frozenClock } from "./fakes.js";
import type { FakeResponse, GateDeferral } from "./fakes.js";
import { assertCaseMatrix } from "./matrix.js";

const FixtureMetaSchema = z.object({
  source: z.string().min(1),
  cases: z.array(z.string().min(1)).min(1),
  clockNow: InstantSchema,
  configPath: z.string().min(1),
  court: z.string(),
  courts: z.array(z.string()).optional(),
  range: z.object({ start: z.string(), end: z.string() }),
  operation: z.enum(["readCourt", "verifyCourt"]).default("readCourt"),
  secrets: z.array(z.string()).default([]),
  rejectSecretEcho: z.boolean().default(false),
  gateDeferral: z
    .object({
      acquire: z.int().positive(),
      until: InstantSchema,
      reason: z.enum(["hold", "pacing", "budget"]),
    })
    .optional(),
});

export interface HarnessArguments {
  platform: Platform;
  tenant: TenantConfig;
  fetch: typeof fetch;
  gate: Gate;
  now: () => Date;
}
export interface ConformanceHarness {
  http: HttpClient;
  execute<T>(operation: () => Promise<T>): Promise<T>;
}
export interface ConformanceOptions {
  createHarness(
    args: HarnessArguments,
  ): ConformanceHarness | Promise<ConformanceHarness>;
  inapplicableCases?: Readonly<Record<string, string>>;
}
export interface ConformanceResult {
  fixtures: number;
  cases: string[];
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Fixture JSON could not be read");
  }
}

function same(actual: unknown, expected: unknown, stage: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Conformance mismatch: ${stage}`);
}

function errorDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { name: "non_error" };
  const details: Record<string, unknown> = { name: error.name };
  const properties = error as Error & Record<string, unknown>;
  for (const field of [
    "code",
    "retryable",
    "retryAfterMs",
    "until",
    "reason",
  ] as const) {
    if (field in properties) details[field] = properties[field];
  }
  return details;
}

export async function runConformance(
  platform: Platform,
  fixturesDir: string,
  options: ConformanceOptions,
): Promise<ConformanceResult> {
  if (!options?.createHarness)
    throw new Error("Conformance requires an injected runtime harness");
  const directories = readdirSync(fixturesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(fixturesDir, entry.name))
    .sort();
  if (!directories.length) throw new Error("No conformance fixtures found");
  const exercised: string[] = [];
  for (const directory of directories) {
    const meta = FixtureMetaSchema.parse(
      readJson(join(directory, "meta.json")),
    );
    const tenant = TenantConfigSchema.parse(
      readJson(resolve(directory, meta.configPath)),
    ) as TenantConfig;
    const responseData = readJson(join(directory, "responses.json"));
    if (!Array.isArray(responseData))
      throw new Error("Fixture responses must be an array");
    const fake = createFakeFetch(responseData as FakeResponse[]);
    const recording = createRecordingGate(
      meta.gateDeferral as GateDeferral | undefined,
    );
    const now = frozenClock(meta.clockNow);
    const harness = await options.createHarness({
      platform,
      tenant,
      fetch: fake.fetch,
      gate: recording.gate,
      now,
    });
    const capabilities = CapabilitiesSchema.parse(
      platform.capabilities(tenant),
    );
    let actual: unknown;
    let thrown: unknown;
    try {
      const connector = platform.createConnector({
        tenant,
        courts: meta.courts,
        http: harness.http,
        now,
      });
      same(connector.capabilities, capabilities, "capabilities");
      actual = await harness.execute(async () => {
        if (meta.operation === "verifyCourt") {
          if (!connector.verifyCourt)
            throw new Error("Identity verification is unavailable");
          return connector.verifyCourt(meta.court);
        }
        return connector.readCourt(meta.court, meta.range);
      });
    } catch (error) {
      thrown = error;
    }

    const errorPath = join(directory, "error.json");
    const expectedPath = join(directory, "expected.json");
    if (existsSync(errorPath) === existsSync(expectedPath))
      throw new Error("Fixture must have one expected output or error");
    if (existsSync(errorPath)) {
      if (thrown === undefined) throw new Error("Expected a connector error");
      const details = errorDetails(thrown);
      same(details, readJson(errorPath), "error");
      if (meta.rejectSecretEcho && details.code !== "schema_changed")
        throw new Error("Reflected secrets must fail as schema_changed");
    } else {
      if (thrown !== undefined) throw new Error("Unexpected connector error");
      if (meta.rejectSecretEcho)
        throw new Error("Reflected secrets must fail the read");
      same(actual, readJson(expectedPath), "output");
      if (meta.operation === "readCourt") {
        const park = tenant.parks.find((item) =>
          item.courts.some((court) => court.key === meta.court),
        );
        const reading = validateCourtReading(actual, {
          shape: capabilities.shape,
          timeZone: tenant.timeZone,
          parkSlug: park?.courttideSlug,
          secrets: meta.secrets,
        });
        if (
          reading.platform !== platform.id ||
          reading.tenant !== tenant.tenant ||
          reading.court !== meta.court ||
          reading.startDate !== meta.range.start ||
          reading.endDate !== meta.range.end
        ) {
          throw new Error("Reading identity does not match the request");
        }
      }
    }
    same(fake.requests, readJson(join(directory, "requests.json")), "requests");
    same(recording.calls, readJson(join(directory, "gate.json")), "gate calls");
    if (fake.remaining() !== 0) throw new Error("Unused synthetic responses");
    exercised.push(...meta.cases);
  }
  assertCaseMatrix(exercised, options.inapplicableCases);
  return { fixtures: directories.length, cases: exercised };
}
