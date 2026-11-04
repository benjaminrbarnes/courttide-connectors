import { readFileSync } from "node:fs";
import type {
  HttpClient,
  HttpRequest,
  HttpResponse,
  TenantConfig,
} from "../../packages/connectors/src/contract/types.js";
import { activeNetPlatform } from "../../packages/connectors/src/platforms/activenet/index.js";
import { describe, expect, it } from "vitest";

const tenant = JSON.parse(
  readFileSync(
    new URL("../../examples/activenet/tenant.json", import.meta.url),
    "utf8",
  ),
) as TenantConfig<{ basePath: string }, Record<string, never>>;
const court = "900001";
const clock = () => new Date("2026-01-02T12:34:56.789Z");

function makeConnector(payload: unknown, selectedCourts = [court]) {
  const calls: HttpRequest[] = [];
  const response: HttpResponse = {
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    text: JSON.stringify(payload),
    requestedAt: "2026-01-02T12:00:00.000Z",
    receivedAt: "2026-01-02T12:00:00.125Z",
  };
  const http: HttpClient = {
    async request(request) {
      calls.push(request);
      return response;
    },
  };
  const connector = activeNetPlatform.createConnector({
    tenant,
    courts: selectedCourts,
    http,
    now: clock,
  });
  return { connector, calls };
}

const calendarPayload = (
  options: { resourceId?: number; code?: string } = {},
) =>
  ({
    headers: { response_code: options.code ?? "0000" },
    body: {
      details: {
        resource_id: options.resourceId ?? Number(court),
        daily_details: [],
      },
    },
  }) as const;

async function expectCode(run: Promise<unknown>, code: string): Promise<void> {
  await expect(run).rejects.toMatchObject({ name: "ConnectorError", code });
}

describe("ActiveNet identity and request validation", () => {
  it("rejects wrong identity, blocked result codes and malformed success envelopes", async () => {
    const wrongId = makeConnector(calendarPayload({ resourceId: 900002 }));
    await expectCode(
      wrongId.connector.readCourt(court, {
        start: "2026-01-02",
        end: "2026-01-02",
      }),
      "identity_mismatch",
    );
    for (const code of [
      "0002",
      "0006",
      "0007",
      "0009",
      "0010",
      "0011",
      "0012",
      "0021",
    ]) {
      const blocked = makeConnector(calendarPayload({ code }));
      await expectCode(
        blocked.connector.readCourt(court, {
          start: "2026-01-02",
          end: "2026-01-02",
        }),
        "access_blocked",
      );
    }
    const malformed = makeConnector(calendarPayload({ code: "9999" }));
    await expectCode(
      malformed.connector.readCourt(court, {
        start: "2026-01-02",
        end: "2026-01-02",
      }),
      "schema_changed",
    );
  });

  it("verifies identity through the fixed detail route and accepts both success codes", async () => {
    const payload = {
      headers: { response_code: "0001" },
      body: {
        resource_detail: {
          general_information: {
            facility_id: 900001,
            facility_name: "  Example Court  ",
            ignored_field: "synthetic-only",
          },
        },
      },
    };
    const { connector, calls } = makeConnector(payload);
    await expect(connector.verifyCourt?.(court)).resolves.toEqual({
      court,
      platformLabel: "Example Court",
    });
    expect(calls[0]?.url.href).toBe(
      "https://example.activecommunities.com/exampleparks/rest/reservation/resource/detail/900001",
    );
    expect(calls[0]?.url.search).toBe("");

    const wrongId = makeConnector({
      ...payload,
      body: {
        resource_detail: {
          general_information: {
            facility_id: 900002,
            facility_name: "Other Example",
          },
        },
      },
    });
    await expectCode(
      wrongId.connector.verifyCourt!(court),
      "identity_mismatch",
    );
    const missingLabel = makeConnector({
      ...payload,
      body: {
        resource_detail: { general_information: { facility_id: 900001 } },
      },
    });
    await expectCode(
      missingLabel.connector.verifyCourt!(court),
      "schema_changed",
    );
  });

  it("validates court allowlists and inclusive date ranges before requesting", async () => {
    const { connector, calls } = makeConnector(calendarPayload());
    await expectCode(
      connector.readCourt("900002", {
        start: "2026-01-02",
        end: "2026-01-02",
      }),
      "identity_mismatch",
    );
    for (const [start, end] of [
      ["2026-02-30", "2026-03-01"],
      ["2026-01-03", "2026-01-02"],
      ["2026-01-01", "2026-01-08"],
    ]) {
      await expectCode(
        connector.readCourt(court, { start: start!, end: end! }),
        "unsupported_time",
      );
    }
    expect(calls).toHaveLength(0);
  });
});
