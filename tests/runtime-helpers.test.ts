import { describe, expect, it } from "vitest";
import {
  assertNoSecretEcho,
  bootstrapAttributes,
  detectChallenge,
  localDateTimeToInstant,
  parseAnonymousBootstrap,
  parseCookieJar,
  parseLocalDate,
  parseRetryAfter,
} from "../packages/connectors/src/index.js";

describe("runtime helpers", () => {
  it("preserves strict and lenient retry-after behavior", () => {
    const now = new Date("2026-11-04T12:00:00.000Z");
    expect(parseRetryAfter("00023", "strict-imf", now)).toEqual({
      retryable: true,
      retryAfterMs: 23000,
    });
    expect(parseRetryAfter("99999999999999", "strict-imf", now)).toEqual({
      retryable: false,
      retryAfterMs: null,
    });
    expect(
      parseRetryAfter("Wed, 04 Nov 2026 12:00:30 GMT", "strict-imf", now),
    ).toEqual({ retryable: true, retryAfterMs: 30000 });
    expect(
      parseRetryAfter("Thu, 04 Nov 2026 12:00:30 GMT", "strict-imf", now)
        .retryable,
    ).toBe(false);
    expect(
      parseRetryAfter("Wed, 04 Nov 2026 11:59:30 GMT", "strict-imf", now)
        .retryAfterMs,
    ).toBe(0);
    expect(
      parseRetryAfter("Wed, 04 Nov 2026 11:59:30 GMT", "lenient", now)
        .retryable,
    ).toBe(false);
    expect(parseRetryAfter("23", "lenient", now).retryAfterMs).toBe(23000);
  });

  it("rejects nonexistent and ambiguous local times", () => {
    expect(parseLocalDate("2026-03-08").toString()).toBe("2026-03-08");
    expect(() => parseLocalDate("2026-02-30")).toThrowError(
      expect.objectContaining({ code: "unsupported_time" }),
    );
    expect(
      localDateTimeToInstant("2026-03-08T03:00:00", "America/New_York"),
    ).toBe("2026-03-08T07:00:00Z");
    for (const value of ["2026-03-08T02:30:00", "2026-11-01T01:30:00"]) {
      expect(() =>
        localDateTimeToInstant(value, "America/New_York"),
      ).toThrowError(expect.objectContaining({ code: "unsupported_time" }));
    }
  });

  it("distinguishes passive assets from challenges", () => {
    const asset = "/cdn-cgi/challenge-platform/scripts/jsd/main.js";
    expect(
      detectChallenge(`<script src="${asset}?example"></script>`, {
        passiveAssets: [asset],
      }),
    ).toBe(false);
    expect(
      detectChallenge(`<script src="${asset}/other"></script>`, {
        passiveAssets: [asset],
      }),
    ).toBe(true);
    expect(detectChallenge("<title>Just a moment</title>")).toBe(true);
    expect(detectChallenge("<form id='challenge-form'></form>")).toBe(true);
    expect(detectChallenge("ordinary synthetic response")).toBe(false);
  });

  it("extracts anonymous bootstrap attributes without executing decoys", () => {
    const encoded =
      "{&quot;checkoutData&quot;:{&quot;user&quot;:null,&quot;key&quot;:&quot;example-session&quot;}}";
    const html = `<!-- <div data-page-data='{}'> --><script>const decoy = '<div data-base-path="bad">';</script><div data-page-data='${encoded}' data-base-path='/XX/example-city/'></div>`;
    expect(bootstrapAttributes(html)).toEqual({
      page: '{"checkoutData":{"user":null,"key":"example-session"}}',
      base: "/XX/example-city/",
    });
    expect(() =>
      bootstrapAttributes(
        `${html}<div data-base-path='/XX/example-city/'></div>`,
      ),
    ).toThrowError(expect.objectContaining({ code: "schema_changed" }));
    expect(() =>
      bootstrapAttributes(
        "<div data-page-data=unquoted data-base-path='/XX/example-city/'></div>",
      ),
    ).toThrowError(expect.objectContaining({ code: "schema_changed" }));
    expect(() =>
      bootstrapAttributes(
        "<div data-page-data='&unknown;' data-base-path='/XX/example-city/'></div>",
      ),
    ).toThrowError(expect.objectContaining({ code: "schema_changed" }));
    const headers = new Headers();
    headers.append(
      "set-cookie",
      "ExampleSession=example-token; Path=/; Secure",
    );
    const parsed = parseAnonymousBootstrap({
      html,
      headers,
      catalogUrl: new URL("https://example.invalid/XX/example-city/catalog"),
      receivedAt: "2026-11-04T12:00:00.000Z",
      cookieDomains: ["example.invalid"],
    });
    expect(parsed).toMatchObject({
      key: "example-session",
      base: "/XX/example-city/",
      cookie: "ExampleSession=example-token",
    });
    expect(() =>
      assertNoSecretEcho(
        { value: "prefix-example-session" },
        [parsed.key],
        parsed.cookieValues,
      ),
    ).toThrowError(expect.objectContaining({ code: "schema_changed" }));
    expect(() =>
      assertNoSecretEcho(
        { value: "example-token" },
        [parsed.key],
        parsed.cookieValues,
      ),
    ).toThrowError(expect.objectContaining({ code: "schema_changed" }));
  });

  it("applies strict cookie scopes, duplication and expiration rules", () => {
    const url = new URL("https://example.invalid/XX/example-city/catalog");
    const endpoint = "/XX/example-city/catalog/getFacilityHours/";
    const receivedAt = "2026-11-04T12:00:00.000Z";
    const options = { cookieDomains: ["example.invalid"] };
    const headers = new Headers();
    const cookie =
      'ExampleSession="example-token"; Path=/; Secure; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
    headers.append("set-cookie", cookie);
    headers.append("set-cookie", cookie);
    expect(parseCookieJar(headers, url, endpoint, receivedAt, options)).toEqual(
      { header: 'ExampleSession="example-token"', values: ["example-token"] },
    );
    for (const bad of [
      "ExampleSession=example; Path=/other; Secure",
      "ExampleSession=example; Path=/; Domain=other.invalid; Secure",
      "ExampleSession=example; Path=/; Secure; Partitioned",
      "__Host-Example=example; Path=/; Domain=example.invalid; Secure",
      "__Secure-Example=example; Path=/",
      "ExampleSession=example; Path=/; Max-Age=0",
    ]) {
      const blocked = new Headers();
      blocked.append("set-cookie", bad);
      expect(() =>
        parseCookieJar(blocked, url, endpoint, receivedAt, options),
      ).toThrowError(expect.objectContaining({ code: "access_blocked" }));
    }
    const conflicting = new Headers();
    conflicting.append("set-cookie", "ExampleSession=one; Path=/");
    conflicting.append("set-cookie", "ExampleSession=two; Path=/");
    expect(() =>
      parseCookieJar(conflicting, url, endpoint, receivedAt, options),
    ).toThrowError(expect.objectContaining({ code: "schema_changed" }));
  });

  it("validates anonymous bootstrap variants before use", () => {
    const headers = new Headers();
    headers.append("set-cookie", "ExampleSession=example-token; Path=/");
    const catalogUrl = new URL(
      "https://example.invalid/XX/example-city/catalog",
    );
    const build = (checkout: unknown, base = "/XX/example-city/") => {
      const page = JSON.stringify({ checkoutData: checkout }).replaceAll(
        '"',
        "&quot;",
      );
      return `<div data-page-data='${page}' data-base-path='${base}'></div>`;
    };
    const parse = (html: string) =>
      parseAnonymousBootstrap({
        html,
        headers,
        catalogUrl,
        receivedAt: "2026-11-04T12:00:00.000Z",
        cookieDomains: ["example.invalid"],
      });
    for (const user of [null, false])
      expect(parse(build({ user, key: "example-session" })).key).toBe(
        "example-session",
      );
    for (const checkout of [
      {},
      { user: 0, key: "example-session" },
      { user: "", key: "example-session" },
      { user: {}, key: "example-session" },
      { user: null, key: "" },
      { user: null, key: "x".repeat(1025) },
    ])
      expect(() => parse(build(checkout))).toThrowError(
        expect.objectContaining({ code: "schema_changed" }),
      );
    expect(() =>
      parse(
        build({ user: null, key: "example-session" }, "/XX/example-other/"),
      ),
    ).toThrowError(expect.objectContaining({ code: "schema_changed" }));
    const numeric = build({ user: null, key: "example-session" }).replaceAll(
      "&quot;",
      "&#34;",
    );
    expect(parse(numeric).key).toBe("example-session");
  });

  it("enforces cookie row and byte limits and accepts scoped host defaults", () => {
    const url = new URL("https://example.invalid/XX/example-city/catalog");
    const endpoint = "/XX/example-city/catalog/getFacilityHours/";
    const receivedAt = "2026-11-04T12:00:00.000Z";
    const options = { cookieDomains: ["example.invalid"] };
    const rows = new Headers();
    rows.append("set-cookie", 'ExampleSession="example-token"; Secure');
    rows.append("set-cookie", "Deleted=example; Max-Age=0; Path=/");
    expect(
      parseCookieJar(rows, url, endpoint, receivedAt, options).header,
    ).toBe('ExampleSession="example-token"');
    const domain = new Headers();
    domain.append(
      "set-cookie",
      "ExampleSession=example-token; Domain=.EXAMPLE.INVALID; Path=/",
    );
    expect(
      parseCookieJar(domain, url, endpoint, receivedAt, options).header,
    ).toBe("ExampleSession=example-token");
    const tooMany = new Headers();
    for (let i = 0; i < 17; i += 1)
      tooMany.append("set-cookie", `Example${i}=example; Path=/`);
    const tooLong = new Headers();
    tooLong.append(
      "set-cookie",
      `ExampleSession=${"x".repeat(16 * 1024)}; Path=/`,
    );
    const repeatedAttribute = new Headers();
    repeatedAttribute.append(
      "set-cookie",
      "ExampleSession=example; Path=/; Path=/",
    );
    for (const invalid of [tooMany, tooLong, repeatedAttribute])
      expect(() =>
        parseCookieJar(invalid, url, endpoint, receivedAt, options),
      ).toThrowError(expect.objectContaining({ code: "schema_changed" }));
  });
});
