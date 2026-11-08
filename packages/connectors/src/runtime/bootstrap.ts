import {
  ConnectorError,
  type ConnectorRejectionReason,
} from "../contract/errors.js";
import { InstantSchema } from "../contract/schemas.js";
import { parseCookieJar } from "./cookies.js";

function invalid(
  reason: ConnectorRejectionReason = "bootstrap_attributes_invalid",
): never {
  throw new ConnectorError("schema_changed", false, null, reason);
}

function decodeAttribute(value: string): string {
  if (/&(?!(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);)/i.test(value))
    return invalid();
  return value.replace(
    /&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi,
    (entity) => {
      const name = entity.slice(1, -1).toLowerCase();
      const named: Record<string, string> = {
        amp: "&",
        quot: '"',
        apos: "'",
        lt: "<",
        gt: ">",
      };
      if (named[name]) return named[name];
      const code = name.startsWith("#x")
        ? Number.parseInt(name.slice(2), 16)
        : Number(name.slice(1));
      if (
        !Number.isInteger(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      )
        return invalid();
      return String.fromCodePoint(code);
    },
  );
}

export function bootstrapAttributes(html: string): {
  page: string;
  base: string;
} {
  if (new TextEncoder().encode(html).byteLength > 1024 * 1024) return invalid();
  const found = new Map<string, string>();
  const lower = html.toLowerCase();
  let cursor = 0;
  while ((cursor = html.indexOf("<", cursor)) !== -1) {
    if (html.startsWith("<!--", cursor)) {
      const end = html.indexOf("-->", cursor + 4);
      if (end < 0) return invalid();
      cursor = end + 3;
      continue;
    }
    let end = cursor + 1;
    let quote = "";
    for (; end < html.length; end += 1) {
      const char = html[end]!;
      if (quote) {
        if (char === quote) quote = "";
      } else if (char === '"' || char === "'") quote = char;
      else if (char === ">") break;
      else if (char === "<") return invalid();
    }
    if (end === html.length) return invalid();
    const tag = html.slice(cursor + 1, end);
    const name = /^[a-z][a-z0-9:-]*/i.exec(tag);
    cursor = end + 1;
    if (!name) continue;
    let index = name[0].length;
    while (index < tag.length) {
      while (/\s/.test(tag[index] ?? "")) index += 1;
      if (index >= tag.length || tag[index] === "/") break;
      const attr = /^[^\s=<>"'/]+/.exec(tag.slice(index));
      if (!attr) return invalid();
      const attribute = attr[0].toLowerCase();
      index += attr[0].length;
      while (/\s/.test(tag[index] ?? "")) index += 1;
      let value: string | null = null;
      if (tag[index] === "=") {
        index += 1;
        while (/\s/.test(tag[index] ?? "")) index += 1;
        const delimiter = tag[index];
        if (delimiter === '"' || delimiter === "'") {
          const finish = tag.indexOf(delimiter, ++index);
          if (finish < 0) return invalid();
          value = tag.slice(index, finish);
          index = finish + 1;
        } else {
          const unquoted = /^[^\s<>"'=]+/.exec(tag.slice(index));
          if (
            !unquoted ||
            attribute === "data-page-data" ||
            attribute === "data-base-path"
          )
            return invalid();
          index += unquoted[0].length;
        }
      }
      if (attribute === "data-page-data" || attribute === "data-base-path") {
        if (value === null || found.has(attribute)) return invalid();
        found.set(attribute, decodeAttribute(value));
      }
    }
    if (
      /^(script|style|textarea|title|xmp|iframe|noembed|noframes|plaintext)$/i.test(
        name[0],
      )
    ) {
      const prefix = `</${name[0].toLowerCase()}`;
      let closing = lower.indexOf(prefix, cursor);
      while (
        closing !== -1 &&
        !/[\s>/]/.test(lower[closing + prefix.length] ?? "")
      )
        closing = lower.indexOf(prefix, closing + prefix.length);
      if (closing === -1) return invalid();
      cursor = closing;
    }
  }
  if (found.size !== 2) return invalid();
  return {
    page: found.get("data-page-data")!,
    base: found.get("data-base-path")!,
  };
}

export function parseAnonymousBootstrap(options: {
  html: string;
  headers: Headers;
  catalogUrl: URL;
  receivedAt: string;
  cookieDomains: readonly string[];
}): {
  key: string;
  base: string;
  cookie: string;
  cookieValues: string[];
  receivedAt: string;
} {
  if (
    !InstantSchema.safeParse(options.receivedAt).success ||
    !options.catalogUrl.pathname.endsWith("/catalog") ||
    options.catalogUrl.search ||
    options.catalogUrl.hash
  )
    return invalid("bootstrap_context_invalid");
  const attrs = bootstrapAttributes(options.html);
  let page: unknown;
  try {
    page = JSON.parse(attrs.page);
  } catch {
    return invalid("bootstrap_json_invalid");
  }
  if (
    !page ||
    typeof page !== "object" ||
    Array.isArray(page) ||
    !("checkoutData" in page)
  )
    return invalid("bootstrap_checkout_invalid");
  const checkout = page.checkoutData;
  if (
    !checkout ||
    typeof checkout !== "object" ||
    Array.isArray(checkout) ||
    !("user" in checkout) ||
    (checkout.user !== null && checkout.user !== false) ||
    !("key" in checkout) ||
    typeof checkout.key !== "string" ||
    !/^[\x21-\x7e]{1,1024}$/.test(checkout.key) ||
    attrs.base !== options.catalogUrl.pathname.slice(0, -"catalog".length)
  )
    return invalid("bootstrap_checkout_invalid");
  const jar = parseCookieJar(
    options.headers,
    options.catalogUrl,
    `${attrs.base}catalog/getFacilityHours/`,
    options.receivedAt,
    { cookieDomains: options.cookieDomains },
  );
  return {
    key: checkout.key,
    base: attrs.base,
    cookie: jar.header,
    cookieValues: jar.values,
    receivedAt: options.receivedAt,
  };
}

export function assertNoSecretEcho(
  value: unknown,
  secrets: readonly string[],
  cookieValues: readonly string[],
): void {
  function contains(item: unknown): boolean {
    if (typeof item === "string")
      return (
        secrets.some((secret) => secret !== "" && item.includes(secret)) ||
        cookieValues.some((cookie) => cookie !== "" && item === cookie)
      );
    if (Array.isArray(item)) return item.some(contains);
    return Boolean(
      item && typeof item === "object" && Object.values(item).some(contains),
    );
  }
  if (contains(value)) throw new ConnectorError("schema_changed");
}
