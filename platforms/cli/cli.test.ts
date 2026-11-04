import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  isDirectExecution,
  runCli,
} from "../../packages/connectors/src/cli/main.js";
import { startFixtureServer } from "../../packages/connectors/src/cli/fixtures.js";
import { writeRecording } from "../../packages/connectors/src/cli/record.js";
import type { ReadResult } from "../../packages/connectors/src/cli/read.js";
import { sanitizedUrl } from "../../packages/connectors/src/cli/read.js";
import { listPlatforms } from "../../packages/connectors/src/cli/registry.js";

const root = process.cwd();
const cases = resolve(root, "examples/activenet/fixtures/cases");
const config = "examples/tenants/activenet.json";
const recordDir = resolve(root, "local/recordings/cli-test-record");

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    value: {
      cwd: root,
      stdout: (message: string) => out.push(message),
      stderr: (message: string) => err.push(message),
      now: () => new Date("2026-10-31T12:00:00.000Z"),
    },
  };
}

function fixtureRequest(name: string): { url: string } {
  return JSON.parse(
    readFileSync(join(cases, name, "requests.json"), "utf8"),
  )[0];
}

afterEach(() => {
  rmSync(recordDir, { recursive: true, force: true });
  rmSync(resolve(root, "local/live-report.json"), { force: true });
});

describe("connector CLI", () => {
  it("recognizes the executable through an installed bin symlink", () => {
    const temporary = mkdtempSync(join(tmpdir(), "connectors-cli-bin-"));
    const target = join(temporary, "main.js");
    const binDirectory = join(temporary, "node_modules", ".bin");
    const bin = join(binDirectory, "courttide-connectors");
    mkdirSync(binDirectory, { recursive: true });
    writeFileSync(target, "");
    symlinkSync(target, bin);
    try {
      expect(isDirectExecution(pathToFileURL(target).href, bin)).toBe(true);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("reads one court through the loopback fixture server and prints credit", async () => {
    const server = await startFixtureServer(join(cases, "midnight-end"));
    try {
      const output = io();
      const status = await runCli(
        [
          "read",
          "activenet",
          "--config",
          config,
          "--court",
          "900001",
          "--date",
          "2026-10-31",
          "--live",
          "--base-url",
          server.url,
        ],
        { ...output.value },
      );
      expect(status, output.err.join("; ")).toBe(0);
      expect(output.out.join("\n")).toContain("open=");
      expect(output.out.join("\n")).toContain(
        "Read with courttide-connectors by CourtTide · https://courttide.com",
      );
    } finally {
      await server.close();
    }
  });

  it("keeps the polite gate gap between a bootstrap and its follow-up read", async () => {
    const server = await startFixtureServer("platforms/civicrec/fixtures/open");
    const requestStarts: number[] = [];
    try {
      const output = io();
      const status = await runCli(
        [
          "read",
          "civicrec",
          "--config",
          "examples/tenants/civicrec.json",
          "--court",
          "900003",
          "--date",
          "2026-11-04",
          "--live",
          "--base-url",
          server.url,
        ],
        {
          ...output.value,
          now: () => new Date(),
          fetch: async (input, init) => {
            requestStarts.push(performance.now());
            return globalThis.fetch(input, init);
          },
        },
      );
      expect(status, output.err.join("; ")).toBe(0);
      expect(requestStarts).toHaveLength(2);
      expect(requestStarts[1]! - requestStarts[0]!).toBeGreaterThanOrEqual(
        9_500,
      );
      expect(output.out.join("\n")).toContain(
        "Read with courttide-connectors by CourtTide",
      );
    } finally {
      await server.close();
    }
  }, 20_000);

  it("refuses multiple courts and non-loopback test origins before fetching", async () => {
    const output = io();
    const multi = await runCli(
      [
        "read",
        "activenet",
        "--config",
        config,
        "--court",
        "900001",
        "--court",
        "900002",
        "--date",
        "2026-10-31",
        "--live",
      ],
      output.value,
    );
    expect(multi).toBe(1);
    expect(output.err.join("\n")).toContain("public MCP for many parks");
    const unsafe = await runCli(
      [
        "read",
        "activenet",
        "--config",
        config,
        "--court",
        "900001",
        "--date",
        "2026-10-31",
        "--live",
        "--base-url",
        "http://example.invalid:3000",
      ],
      output.value,
    );
    expect(unsafe).toBe(1);
    expect(output.err.join("\n")).toContain("loopback");
  });

  it("redacts session context and provider resource IDs from local request logs", () => {
    const result = sanitizedUrl(
      "https://secure.rec1.com/XX/example-city/catalog/getFacilityHours/example-session/900003/900004/2026-11-04",
    );
    expect(result).not.toContain("example-session");
    expect(result).toContain("[redacted]");
    expect(result).not.toContain("900003");
    expect(result).not.toContain("900004");
    expect(result).toContain("2026-11-04");
  });

  it("serves fixture responses only on a loopback listener", async () => {
    const request = fixtureRequest("midnight-end");
    const output = io();
    let responseText = "";
    const status = await runCli(["serve", join(cases, "midnight-end")], {
      ...output.value,
      onServe: async (url, close) => {
        try {
          const response = await fetch(
            `${url}${new URL(request.url).pathname}${new URL(request.url).search}`,
          );
          responseText = await response.text();
          expect(response.status).toBe(200);
        } finally {
          await close();
        }
      },
    });
    expect(status, output.err.join("; ")).toBe(0);
    expect(output.out[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(responseText).toContain("response_code");
  });

  it("replays synthetic conformance fixtures offline", async () => {
    const output = io();
    const status = await runCli(["replay", cases], output.value);
    expect(status).toBe(0);
    expect(output.out.join("\n")).toContain("Replay passed for activenet");
  });

  it("records, serves, and replays a scrubbed conformance fixture locally", async () => {
    const server = await startFixtureServer(join(cases, "midnight-end"));
    try {
      const output = io();
      const status = await runCli(
        [
          "record",
          "activenet",
          "--config",
          config,
          "--court",
          "900001",
          "--date",
          "2026-10-31",
          "--live",
          "--case",
          "cli-test-record",
          "--base-url",
          server.url,
        ],
        output.value,
      );
      expect(status, output.err.join("; ")).toBe(0);
      const meta = JSON.parse(
        readFileSync(join(recordDir, "meta.json"), "utf8"),
      );
      expect(meta.source).toBe("recorded");
      expect(meta.inventedFields).toHaveLength(1);
      expect(
        JSON.parse(readFileSync(join(recordDir, "requests.json"), "utf8")),
      ).toHaveLength(1);
      expect(
        JSON.parse(readFileSync(join(recordDir, "gate.json"), "utf8")),
      ).toHaveLength(2);
      expect(
        JSON.parse(readFileSync(join(recordDir, "expected.json"), "utf8"))
          .sanitized,
      ).toBeDefined();
      expect(
        JSON.parse(readFileSync(join(recordDir, "responses.json"), "utf8"))[0]
          .body,
      ).not.toContain("session");
      expect(recordDir).not.toContain(`${join(root, "fixtures")}/`);
      const replay = io();
      expect(await runCli(["replay", recordDir], replay.value)).toBe(0);
      const request = fixtureRequest("midnight-end");
      let responseText = "";
      const served = io();
      expect(
        await runCli(["serve", recordDir], {
          ...served.value,
          onServe: async (url, close) => {
            try {
              const route = new URL(request.url);
              const response = await fetch(
                `${url}${route.pathname}${route.search}`,
              );
              responseText = await response.text();
              expect(response.status).toBe(200);
            } finally {
              await close();
            }
          },
        }),
      ).toBe(0);
      expect(responseText).toContain("response_code");
    } finally {
      await server.close();
    }
  });

  it("refuses to follow a local directory symlink into fixtures", () => {
    const temporary = mkdtempSync(join(tmpdir(), "connectors-cli-record-"));
    const fixtures = join(temporary, "fixtures");
    mkdirSync(fixtures);
    writeFileSync(join(temporary, ".gitignore"), "local/\n");
    execFileSync("git", ["init", "--quiet"], { cwd: temporary });
    symlinkSync("fixtures", join(temporary, "local"), "dir");
    const result = {
      requestLog: [],
      gateLog: [],
      reading: {
        platform: "activenet",
        tenant: "exampleparks",
        court: "900001",
        startDate: "2026-01-02",
        endDate: "2026-01-02",
        complete: true,
        observedAt: "2026-01-02T12:00:00.000Z",
        days: [],
        sanitized: {},
        parser: { id: "synthetic", version: "1", signature: "test" },
        attribution: {
          text: "Read with courttide-connectors by CourtTide",
          url: "https://courttide.com",
        },
      },
    } as unknown as ReadResult;
    try {
      expect(() =>
        writeRecording(
          temporary,
          "symlinked-output",
          result,
          new Date(),
          "tenant.json",
        ),
      ).toThrow(/regular local/);
      expect(readdirSync(fixtures)).toEqual([]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("refuses to follow a local directory symlink into fixtures", () => {
    const temporary = mkdtempSync(join(tmpdir(), "connectors-cli-record-"));
    const fixtures = join(temporary, "fixtures");
    mkdirSync(fixtures);
    writeFileSync(join(temporary, ".gitignore"), "local/\n");
    execFileSync("git", ["init", "--quiet"], { cwd: temporary });
    symlinkSync("fixtures", join(temporary, "local"), "dir");
    const result = {
      requestLog: [],
      gateLog: [],
      reading: {
        platform: "activenet",
        tenant: "exampleparks",
        court: "900001",
        startDate: "2026-01-02",
        endDate: "2026-01-02",
        complete: true,
        observedAt: "2026-01-02T12:00:00.000Z",
        days: [],
        sanitized: {},
        parser: { id: "synthetic", version: "1", signature: "test" },
        attribution: {
          text: "Read with courttide-connectors by CourtTide",
          url: "https://courttide.com",
        },
      },
    } as unknown as ReadResult;
    try {
      expect(() =>
        writeRecording(
          temporary,
          "symlinked-output",
          result,
          new Date(),
          "tenant.json",
        ),
      ).toThrow(/regular local/);
      expect(readdirSync(fixtures)).toEqual([]);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });

  it("checks tenant configs, conformance and the repository data guard", async () => {
    const output = io();
    let guarded = false;
    const status = await runCli(["check", config], {
      ...output.value,
      checkRepository: () => {
        execFileSync(process.execPath, ["scripts/check-no-court-data.mjs"], {
          cwd: root,
          stdio: "ignore",
        });
        guarded = true;
      },
    });
    expect(status, output.err.join("; ")).toBe(0);
    expect(guarded).toBe(true);
    expect(output.out.join("\n")).toContain("tenant config(s)");
  }, 15_000);

  it("lists platform capabilities without tenant configurations", async () => {
    const output = io();
    const status = await runCli(["list"], output.value);
    expect(status).toBe(0);
    const platforms = JSON.parse(output.out[0]!);
    expect(platforms.map((platform: { id: string }) => platform.id)).toContain(
      "activenet",
    );
    expect(platforms[0]).not.toHaveProperty("tenant");
    const packageExports = JSON.parse(
      readFileSync(join(root, "packages/connectors/package.json"), "utf8"),
    ).exports as Record<string, unknown>;
    const registeredIds = listPlatforms()
      .map((platform) => platform.id)
      .sort();
    const publishedIds = Object.keys(packageExports)
      .filter(
        (key) =>
          key.startsWith("./") &&
          key !== "./testing" &&
          !key.startsWith("./schema/"),
      )
      .map((key) => key.slice(2))
      .sort();
    expect(registeredIds).toEqual(publishedIds);
  });

  it("runs counts-only live-test mode against loopback and writes a report", async () => {
    const server = await startFixtureServer(join(cases, "midnight-end"));
    try {
      const output = io();
      const status = await runCli(
        [
          "test:live",
          "--config",
          config,
          "--platform",
          "activenet",
          "--courts",
          "900001",
          "--base-url",
          server.url,
        ],
        { ...output.value, ci: false },
      );
      expect(status).toBe(0);
      expect(output.out.join("\n")).toContain("passed=1");
      expect(output.out.join("\n")).not.toContain("900001");
      expect(output.out.join("\n")).toContain("courttide.com");
      const report = JSON.parse(
        readFileSync(resolve(root, "local/live-report.json"), "utf8"),
      );
      expect(report).toMatchObject({ selected: 1, passed: 1, exitCode: 0 });
      expect(report).not.toHaveProperty("courts");
    } finally {
      await server.close();
    }
  });

  it("refuses live mode in CI before reading config or fetching", async () => {
    let fetched = false;
    const output = io();
    const status = await runCli(
      ["test:live", "--config", "missing-secret-config"],
      {
        ...output.value,
        ci: true,
        fetch: async () => {
          fetched = true;
          return new Response(null, { status: 200 });
        },
      },
    );
    expect(status).toBe(3);
    expect(fetched).toBe(false);
    expect(output.err.join("\n")).toContain("disabled in CI");
    expect(existsSync(resolve(root, "local/live-report.json"))).toBe(false);
  });

  it("maps unknown status, rate limits, and blocks to live-runner exit codes", async () => {
    const scenarios = [
      { fixture: "unknown-status", expected: 1, count: "parseFailures=1" },
      { fixture: "rate-limit-no-delay", expected: 2, count: "inconclusive=1" },
      { fixture: "forbidden", expected: 3, count: "blocked=1" },
    ];
    for (const scenario of scenarios) {
      const server = await startFixtureServer(join(cases, scenario.fixture));
      try {
        const output = io();
        const status = await runCli(
          [
            "test:live",
            "--config",
            config,
            "--platform",
            "activenet",
            "--courts",
            "900001",
            "--base-url",
            server.url,
          ],
          {
            ...output.value,
            ci: false,
            now: () => new Date("2026-01-02T12:00:00.000Z"),
          },
        );
        expect(status).toBe(scenario.expected);
        expect(output.out.join("\n")).toContain(scenario.count);
        expect(output.out.join("\n")).not.toContain("900001");
        const report = JSON.parse(
          readFileSync(resolve(root, "local/live-report.json"), "utf8"),
        );
        expect(report.exitCode).toBe(scenario.expected);
        expect(report.selected).toBe(1);
      } finally {
        await server.close();
      }
    }
  });

  it("rejects unsupported platform configs instead of skipping validation", async () => {
    const temp = mkdtempSync(join(tmpdir(), "connectors-unknown-platform-"));
    const invalid = JSON.parse(readFileSync(join(root, config), "utf8"));
    invalid.platform = "not-registered";
    writeFileSync(join(temp, "tenant.json"), JSON.stringify(invalid));
    const output = io();
    try {
      const status = await runCli(
        ["check", join(temp, "tenant.json")],
        output.value,
      );
      expect(status).toBe(1);
      expect(output.err.join("\n")).toContain(
        "Unsupported platform: not-registered",
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
