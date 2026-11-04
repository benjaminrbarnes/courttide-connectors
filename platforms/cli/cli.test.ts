import { execFileSync } from "node:child_process";
import {
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
import { afterEach, describe, expect, it } from "vitest";
import { runCli } from "../../packages/connectors/src/cli/main.js";
import { startFixtureServer } from "../../packages/connectors/src/cli/fixtures.js";
import { writeRecording } from "../../packages/connectors/src/cli/record.js";
import type { ReadResult } from "../../packages/connectors/src/cli/read.js";
import { sanitizedUrl } from "../../packages/connectors/src/cli/read.js";

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
});

describe("connector CLI", () => {
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
      expect(status).toBe(0);
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
    expect(status).toBe(0);
    expect(output.out[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(responseText).toContain("response_code");
  });

  it("replays synthetic conformance fixtures offline", async () => {
    const output = io();
    const status = await runCli(["replay", cases], output.value);
    expect(status).toBe(0);
    expect(output.out.join("\n")).toContain("Replay passed for activenet");
  });

  it("records a scrubbed local fixture and never writes it into fixtures", async () => {
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
      expect(status).toBe(0);
      const recording = JSON.parse(
        readFileSync(join(recordDir, "record.json"), "utf8"),
      );
      expect(recording.source).toBe("recorded");
      expect(recording.requestLog).toHaveLength(1);
      expect(recording.gateLog).toHaveLength(2);
      expect(recording.reading.sanitizedPayload).toBeDefined();
      expect(recording.reading.sourceUrl).toBeUndefined();
      expect(recording.requestLog[0].headerNames).toEqual(["accept"]);
      expect(
        resolve(root, "local/recordings/cli-test-record/record.json"),
      ).not.toContain(`${join(root, "fixtures")}/`);
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
        writeRecording(temporary, "symlinked-output", result, new Date()),
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
        writeRecording(temporary, "symlinked-output", result, new Date()),
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
    expect(status).toBe(0);
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
  });

  it("runs the local live-test mode against loopback only", async () => {
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
        output.value,
      );
      expect(status).toBe(0);
      expect(output.out.join("\n")).toContain("2026-10-31");
    } finally {
      await server.close();
    }
  });
});
