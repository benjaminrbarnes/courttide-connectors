import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../packages/connectors/src/cli/main.js";
import { activeTenant, civicTenant } from "./runtime-support.js";

const args = [
  "read",
  "activenet",
  "--config",
  resolve("examples/tenants/activenet.json"),
  "--court",
  "900001",
  "--date",
  "2026-10-31",
  "--live",
];
const env = {
  CONNECTORS_ADMISSION_RESERVE_URL: "https://example.invalid/reserve",
  CONNECTORS_ADMISSION_OUTCOME_URL:
    "https://example.invalid/{reservationId}/outcome",
  CONNECTORS_ADMISSION_SOURCE_ORIGIN: activeTenant.origin,
  CONNECTORS_ADMISSION_BEARER: "synthetic-bearer",
};
const reserved = {
  result: "reserved",
  reservationId: "00000000-0000-4000-8000-000000000001",
  allowanceOwner: "00000000-0000-4000-8000-000000000002",
  budgetDate: "2026-11-04",
  used: 1,
  cap: 10,
  warningCrossed: false,
};
const rows = JSON.parse(
  readFileSync(
    "examples/activenet/fixtures/cases/midnight-end/responses.json",
    "utf8",
  ),
) as { body: string; headers: Record<string, string>; status: number }[];
function response(value: unknown) {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
}
let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "connector-admission-test-"));
  execFileSync("git", ["init", "-q", scratch]);
  writeFileSync(join(scratch, ".gitignore"), "local/\n");
});

function output() {
  const stdout: string[] = [],
    stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      cwd: scratch,
      stdout: (s: string) => stdout.push(s),
      stderr: (s: string) => stderr.push(s),
      now: () => new Date("2026-10-31T12:00:00Z"),
    },
  };
}

afterEach(() => rmSync(scratch, { recursive: true, force: true }));

describe("CLI admission configuration", () => {
  it("uses configured service admission for an ordinary read without exposing its bearer", async () => {
    const out = output();
    const bodies: unknown[] = [];
    const admissionFetch = vi.fn<typeof fetch>(async (input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return String(input).endsWith("/reserve")
        ? response(reserved)
        : response({ recorded: true });
    });
    const provider = vi.fn<typeof fetch>(
      async () => new Response(rows[0]!.body, rows[0]!),
    );
    const status = await runCli(args, {
      ...out.io,
      env,
      admissionFetch,
      fetch: provider,
    });
    expect(status, out.stderr.join("\n")).toBe(0);
    expect(provider).toHaveBeenCalledOnce();
    expect(bodies).toEqual([
      { purpose: "calendar" },
      { result: "success", status: 200 },
    ]);
    expect(`${out.stdout.join()} ${out.stderr.join()}`).not.toContain(
      env.CONNECTORS_ADMISSION_BEARER,
    );
    expect(
      new Headers(provider.mock.calls[0]![1]?.headers).has("authorization"),
    ).toBe(false);
  });

  it.each([
    { CONNECTORS_ADMISSION_RESERVE_URL: "https://example.invalid/reserve" },
    { ...env, CONNECTORS_ADMISSION_BEARER: "" },
    { ...env, CONNECTORS_ADMISSION_SOURCE_ORIGIN: "https://other.invalid" },
  ])("fails closed for partial or mismatched settings", async (setting) => {
    const out = output();
    const admissionFetch = vi.fn<typeof fetch>(async () => response(reserved));
    const provider = vi.fn<typeof fetch>();
    expect(
      await runCli(args, {
        ...out.io,
        env: setting,
        admissionFetch,
        fetch: provider,
      }),
    ).toBe(1);
    expect(provider).not.toHaveBeenCalled();
    expect(admissionFetch).not.toHaveBeenCalled();
    expect(`${out.stdout.join()} ${out.stderr.join()}`).not.toContain(
      "synthetic-bearer",
    );
  });

  it("treats an admission deferral as an inconclusive test and sends no provider request", async () => {
    const out = output();
    const admissionFetch = vi.fn<typeof fetch>(async () =>
      response({ result: "deferred", deferUntil: null, operatorHold: true }),
    );
    const provider = vi.fn<typeof fetch>();
    const testArgs = [
      "test:live",
      "--config",
      resolve("examples/tenants/activenet.json"),
      "--date",
      "2026-10-31",
    ];
    const status = await runCli(testArgs, {
      ...out.io,
      env,
      ci: false,
      admissionFetch,
      fetch: provider,
    });
    expect(status).toBe(2);
    expect(provider).not.toHaveBeenCalled();
    expect(admissionFetch).toHaveBeenCalledOnce();
    expect(`${out.stdout.join()} ${out.stderr.join()}`).not.toContain(
      "synthetic-bearer",
    );
  });
  it("rejects mixed source origins before reserving or fetching", async () => {
    const out = output();
    const admissionFetch = vi.fn<typeof fetch>(async () => response(reserved));
    const provider = vi.fn<typeof fetch>();
    const status = await runCli(
      [
        "test:live",
        "--config",
        resolve("examples/tenants"),
        "--date",
        "2026-10-31",
      ],
      { ...out.io, env, ci: false, admissionFetch, fetch: provider },
    );
    expect(status).toBe(1);
    expect(out.stderr).toEqual(["Admission service unavailable"]);
    expect(admissionFetch).not.toHaveBeenCalled();
    expect(provider).not.toHaveBeenCalled();
  });
  it.each([
    [...args, "--base-url", "http://127.0.0.1:12345"],
    [
      "test:live",
      "--config",
      resolve("examples/tenants/activenet.json"),
      "--date",
      "2026-10-31",
      "--base-url",
      "http://127.0.0.1:12345",
    ],
  ])(
    "refuses to report loopback fixture responses to admission",
    async (...argv) => {
      const out = output();
      const admissionFetch = vi.fn<typeof fetch>();
      const provider = vi.fn<typeof fetch>();
      expect(
        await runCli(argv, {
          ...out.io,
          env,
          ci: false,
          admissionFetch,
          fetch: provider,
        }),
      ).toBe(1);
      expect(out.stderr).toEqual(["Admission service unavailable"]);
      expect(admissionFetch).not.toHaveBeenCalled();
      expect(provider).not.toHaveBeenCalled();
    },
  );
  it("treats an ambiguous per-request outcome report as inconclusive and stops", async () => {
    const out = output();
    const bootstrap = JSON.parse(
      readFileSync("platforms/civicrec/fixtures/open/responses.json", "utf8"),
    )[0] as { status: number; headers: [string, string][]; body: string };
    const admissionFetch = vi.fn<typeof fetch>(async (input) =>
      String(input).endsWith("/reserve")
        ? response(reserved)
        : new Response(null, { status: 409 }),
    );
    const provider = vi.fn<typeof fetch>(
      async () =>
        new Response(bootstrap.body, {
          status: bootstrap.status,
          headers: bootstrap.headers,
        }),
    );
    const civicEnv = {
      ...env,
      CONNECTORS_ADMISSION_SOURCE_ORIGIN: civicTenant.origin,
    };
    const status = await runCli(
      [
        "test:live",
        "--config",
        resolve("examples/tenants/civicrec.json"),
        "--date",
        "2026-11-04",
      ],
      { ...out.io, env: civicEnv, ci: false, admissionFetch, fetch: provider },
    );
    expect(status).toBe(2);
    expect(out.stdout.join("\n")).toContain("inconclusive=1");
    expect(provider).toHaveBeenCalledOnce();
    expect(admissionFetch).toHaveBeenCalledTimes(2);
  });
});
