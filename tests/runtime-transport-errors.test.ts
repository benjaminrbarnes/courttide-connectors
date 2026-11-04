import { expect, it } from "vitest";
import {
  activeNetLegacyProfile,
  civicRecLegacyProfile,
  ConnectorError,
  type TransportProfile,
} from "../packages/connectors/src/index.js";
import { createRecordingGate } from "../packages/connectors/src/testing/index.js";
import {
  activeRequest,
  activeTenant,
  civicRequest,
  civicTenant,
  runtime,
} from "./runtime-support.js";

async function trial(
  profile: TransportProfile,
  stage: string,
  failure: unknown,
  civic = false,
) {
  const recording = createRecordingGate();
  const client = runtime(
    civic ? civicTenant : activeTenant,
    profile,
    recording.gate,
    async () => {
      if (stage === "headers") throw failure;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(failure);
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    },
  );
  const error = await client
    .execute(() =>
      client.http.request(civic ? civicRequest() : activeRequest()),
    )
    .catch((e: unknown) => e);
  return { error, release: recording.calls.at(-1) };
}

it.each([
  [false, "headers"],
  [false, "body"],
  [true, "headers"],
  [true, "body"],
] as const)(
  "treats typed raw transport errors as HTTP failures (CivicRec=%s, %s)",
  async (civic, stage) => {
    const { error, release } = await trial(
      civic ? civicRecLegacyProfile : activeNetLegacyProfile,
      stage,
      new ConnectorError("access_blocked"),
      civic,
    );
    expect(error).toMatchObject({
      code: "http_error",
      retryable: false,
      retryAfterMs: null,
    });
    expect(release).toMatchObject({
      type: "release",
      outcome: { error: "http_error", retryable: false },
    });
  },
);

it.each(["headers", "body"])(
  "maps only caller-approved transport errors during %s",
  async (stage) => {
    class CallerFailure extends Error {}
    const original = Object.assign(new CallerFailure("example-sensitive"), {
      detail: "example-sensitive",
    });
    const profile: TransportProfile = {
      ...civicRecLegacyProfile,
      classifyTransportError: (error) =>
        error instanceof CallerFailure
          ? new ConnectorError("rate_limited", true, 120000)
          : undefined,
    };
    const mapped = await trial(profile, stage, original, true);
    expect(mapped.error).toMatchObject({
      code: "rate_limited",
      retryable: true,
      retryAfterMs: 120000,
    });
    expect(JSON.stringify(mapped)).not.toContain("example-sensitive");
    const ordinary = await trial(
      profile,
      stage,
      new ConnectorError("access_blocked"),
      true,
    );
    expect(ordinary.error).toMatchObject({
      code: "http_error",
      retryable: false,
    });
  },
);

it("retains explicit typed transport controls when a profile requests them", async () => {
  const result = await trial(
    { ...activeNetLegacyProfile, transportErrors: "preserve" },
    "headers",
    new ConnectorError("rate_limited", true, 23000),
  );
  expect(result.error).toMatchObject({
    code: "rate_limited",
    retryable: true,
    retryAfterMs: 23000,
  });
});

it("preserves a classifier failure after successful transport", async () => {
  const recording = createRecordingGate();
  const client = runtime(
    civicTenant,
    {
      ...civicRecLegacyProfile,
      classify() {
        throw new ConnectorError("access_blocked");
      },
    },
    recording.gate,
    async () => Response.json({}),
  );
  await expect(
    client.execute(() => client.http.request(civicRequest())),
  ).rejects.toMatchObject({ code: "access_blocked", retryable: false });
  expect(recording.calls.at(-1)).toMatchObject({
    type: "release",
    outcome: { error: "access_blocked" },
  });
});
