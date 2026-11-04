import { Temporal } from "@js-temporal/polyfill";
import { ConnectorError } from "../../contract/errors.js";
import type { HttpClient, HttpResponse } from "../../contract/types.js";
import {
  assertNoSecretEcho,
  parseAnonymousBootstrap,
} from "../../runtime/bootstrap.js";
import { parseCivicrecHours } from "./hours.js";
import type { CivicRecConfig, SelectedCourt } from "./config.js";

function invalid(): never {
  throw new ConnectorError("schema_changed");
}
function checked(response: HttpResponse) {
  if (
    !response ||
    response.status !== 200 ||
    !(response.headers instanceof Headers) ||
    typeof response.text !== "string" ||
    response.text.length > 1024 * 1024 ||
    typeof response.requestedAt !== "string" ||
    response.requestedAt.length > 80 ||
    typeof response.receivedAt !== "string" ||
    response.receivedAt.length > 80 ||
    new TextEncoder().encode(response.text).byteLength > 1024 * 1024
  )
    return invalid();
  try {
    const requested = Temporal.Instant.from(response.requestedAt);
    const received = Temporal.Instant.from(response.receivedAt);
    if (Temporal.Instant.compare(requested, received) > 0) return invalid();
    return {
      ...response,
      requestedAt: requested.toString(),
      receivedAt: received.toString(),
    };
  } catch {
    return invalid();
  }
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class CivicRecReader {
  private bootstrap?: Promise<ReturnType<typeof parseAnonymousBootstrap>>;
  constructor(
    private readonly config: CivicRecConfig,
    private readonly http: HttpClient,
  ) {}

  private async loadBootstrap(court: string) {
    const response = checked(
      await this.http.request({
        court,
        purpose: "bootstrap",
        method: "GET",
        url: new URL(this.config.catalogUrl.href),
        headers: { accept: "text/html" },
        expect: "html",
      }),
    );
    const type = response.headers
      .get("content-type")
      ?.split(";")[0]
      ?.trim()
      .toLowerCase();
    if (type !== "text/html") throw new ConnectorError("access_blocked");
    return parseAnonymousBootstrap({
      html: response.text,
      headers: response.headers,
      catalogUrl: this.config.catalogUrl,
      receivedAt: response.receivedAt,
      cookieDomains: ["secure.rec1.com", "rec1.com"],
    });
  }

  async readHours(court: SelectedCourt, date: string) {
    const facilityId = String(court.params.facilityId);
    const rateTypeId = String(court.params.rateTypeId);
    const bootstrap = await (this.bootstrap ??= this.loadBootstrap(court.key));
    const path = `${bootstrap.base}catalog/getFacilityHours/${encodeURIComponent(bootstrap.key)}/${facilityId}/${rateTypeId}/${date}`;
    const url = new URL(path, this.config.catalogUrl);
    if (
      url.origin !== this.config.catalogUrl.origin ||
      url.pathname !== path ||
      url.search ||
      url.hash ||
      url.href.length > 4096
    )
      return invalid();
    const response = checked(
      await this.http.request({
        court: court.key,
        purpose: "calendar",
        method: "GET",
        url,
        headers: {
          accept: "application/json",
          "x-requested-with": "XMLHttpRequest",
          cookie: bootstrap.cookie,
        },
        expect: "json",
      }),
    );
    if (
      Temporal.Instant.compare(response.requestedAt, bootstrap.receivedAt) < 0
    )
      return invalid();
    let payload: unknown;
    try {
      payload = JSON.parse(response.text);
    } catch {
      return invalid();
    }
    if (
      object(payload) &&
      typeof payload.error === "string" &&
      /expired|denied|unauthorized|forbidden|login required/i.test(
        payload.error,
      )
    )
      throw new ConnectorError("access_blocked");
    if (
      !object(payload) ||
      !Object.hasOwn(payload, "hours") ||
      !Object.hasOwn(payload, "displayHours") ||
      !Object.hasOwn(payload, "availableForRate")
    )
      return invalid();
    const evidence = parseCivicrecHours(payload, {
      facilityId,
      rateTypeId,
      date,
      timeZone: this.config.timeZone,
    });
    if (evidence.kind === "invalid") return invalid();
    assertNoSecretEcho(
      evidence,
      [
        bootstrap.key,
        encodeURIComponent(bootstrap.key),
        bootstrap.cookie,
        ...bootstrap.cookieValues.filter((value) => value.length >= 8),
      ],
      bootstrap.cookieValues,
    );
    return { evidence, receivedAt: response.receivedAt };
  }
}
