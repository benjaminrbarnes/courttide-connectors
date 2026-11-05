import { createHash } from "node:crypto";
import { ConnectorError } from "../contract/errors.js";
import type {
  HttpClient,
  TenantConfig,
  TransportProfile,
} from "../contract/types.js";
import type { parseAnonymousBootstrap } from "./bootstrap.js";
import { bounded } from "./async.js";
import { parseCookieJarWithExpiry } from "./cookies.js";

declare const sessionStoreBrand: unique symbol;
/** Opaque, process-local storage for successful anonymous bootstrap sessions. */
export interface SessionStore {
  readonly [sessionStoreBrand]: never;
  clear(): void;
}
export interface SessionStoreOptions {
  /** Local policy only; this is not a claim about the upstream session TTL. */
  maxAgeMs: number;
  maxEntries?: number;
}

type Bootstrap = ReturnType<typeof parseAnonymousBootstrap>;
export interface CookieProof {
  headers: Headers;
  url: URL;
  endpointPath: string;
  receivedAt: string;
}
interface StoredSession {
  token: object;
  bootstrap: Bootstrap;
  proof: CookieProof;
  receivedAt: number;
  expiresAt: number;
}
type Entry =
  | { kind: "pending"; promise: Promise<StoredSession> }
  | { kind: "ready"; session: StoredSession };
interface StoreState {
  entries: Map<string, Entry>;
  functions: WeakMap<Function, number>;
  nextFunction: number;
  transports: WeakMap<object, number>;
  nextTransport: number;
  maxAgeMs: number;
  maxEntries: number;
  lastNow: number;
}
interface Binding {
  store: StoreState;
  key: string;
  tenant: TenantConfig;
  profile: TransportProfile;
  leaseScope: "per_read" | "per_request";
  transportIdentity: object;
  signal?: AbortSignal;
  activeToken?: object;
  findProof(bootstrap: Bootstrap): CookieProof;
  importProof(proof: CookieProof): void;
}
const stores = new WeakMap<SessionStore, StoreState>();
const bindings = new WeakMap<HttpClient, Binding>();
const MAX_AGE_MS = 60 * 60 * 1000;
const MAX_SCOPE_BYTES = 1024 * 1024;

function invalid(): never {
  throw new ConnectorError("schema_changed");
}

/** The store is deliberately not serializable and exposes no session material. */
export function createSessionStore(options: SessionStoreOptions): SessionStore {
  if (
    !options ||
    !Number.isSafeInteger(options.maxAgeMs) ||
    options.maxAgeMs < 1 ||
    options.maxAgeMs > MAX_AGE_MS ||
    (options.maxEntries !== undefined &&
      (!Number.isSafeInteger(options.maxEntries) ||
        options.maxEntries < 1 ||
        options.maxEntries > 64))
  )
    return invalid();
  const state: StoreState = {
    entries: new Map(),
    functions: new WeakMap(),
    nextFunction: 1,
    transports: new WeakMap(),
    nextTransport: 1,
    maxAgeMs: options.maxAgeMs,
    maxEntries: options.maxEntries ?? 16,
    lastNow: 0,
  };
  const store = Object.freeze({
    clear() {
      state.entries.clear();
    },
  }) as SessionStore;
  stores.set(store, state);
  return store;
}

// Function identity is part of the policy: equal-looking closures may differ.
function scopeKey(
  state: StoreState,
  tenant: TenantConfig,
  profile: TransportProfile,
  leaseScope: Binding["leaseScope"],
  transportIdentity: object,
): string {
  const chunks: string[] = [];
  const seen = new Set<object>();
  let bytes = 0;
  let nodes = 0;
  function add(value: string) {
    bytes += Buffer.byteLength(value);
    if (bytes > MAX_SCOPE_BYTES) return invalid();
    chunks.push(value);
  }
  function visit(value: unknown, depth: number): void {
    if (++nodes > 20_000 || depth > 32) return invalid();
    if (value === null) return add("null;");
    if (value === undefined) return add("undefined;");
    if (typeof value === "string")
      return add(`string:${JSON.stringify(value)};`);
    if (typeof value === "boolean") return add(value ? "true;" : "false;");
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return invalid();
      return add(`number:${Object.is(value, -0) ? "-0" : value};`);
    }
    if (typeof value === "function") {
      let id = state.functions.get(value);
      if (id === undefined) {
        id = state.nextFunction++;
        state.functions.set(value, id);
      }
      return add(`function:${id};`);
    }
    if (typeof value !== "object" || seen.has(value)) return invalid();
    seen.add(value);
    if (Array.isArray(value)) {
      if (
        Object.getPrototypeOf(value) !== Array.prototype ||
        Object.getOwnPropertySymbols(value).length ||
        value.length > 20_000
      )
        return invalid();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.keys(descriptors).length !== value.length + 1)
        return invalid();
      add("[");
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = descriptors[index];
        if (!descriptor || !("value" in descriptor)) return invalid();
        visit(descriptor.value, depth + 1);
      }
      add("]");
    } else {
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null)
        return invalid();
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.getOwnPropertySymbols(value).length) return invalid();
      add("{");
      for (const key of Object.keys(descriptors).sort()) {
        const descriptor = descriptors[key]!;
        if (!("value" in descriptor)) return invalid();
        add(`key:${JSON.stringify(key)};`);
        visit(descriptor.value, depth + 1);
      }
      add("}");
    }
    seen.delete(value);
  }
  let transport = state.transports.get(transportIdentity);
  if (transport === undefined) {
    transport = state.nextTransport++;
    state.transports.set(transportIdentity, transport);
  }
  visit(["anonymous", tenant, profile, leaseScope, transport], 0);
  return createHash("sha256").update(chunks.join("")).digest("hex");
}

function now(state: StoreState): number {
  const value = Date.now();
  if (!Number.isFinite(value)) return invalid();
  if (value < state.lastNow) state.entries.clear();
  state.lastNow = value;
  return value;
}

export function bindSession(
  http: HttpClient,
  options: {
    store: SessionStore;
    account?: "anonymous";
    tenant: TenantConfig;
    profile: TransportProfile;
    leaseScope: Binding["leaseScope"];
    transportIdentity: object;
    signal?: AbortSignal;
    findProof: Binding["findProof"];
    importProof: Binding["importProof"];
  },
): () => void {
  const state = stores.get(options.store);
  if (
    !state ||
    (options.account !== undefined && options.account !== "anonymous")
  )
    return invalid();
  if (
    (typeof options.transportIdentity !== "object" &&
      typeof options.transportIdentity !== "function") ||
    options.transportIdentity === null
  )
    return invalid();
  const key = scopeKey(
    state,
    options.tenant,
    options.profile,
    options.leaseScope,
    options.transportIdentity,
  );
  const binding: Binding = {
    store: state,
    key,
    tenant: options.tenant,
    profile: options.profile,
    leaseScope: options.leaseScope,
    transportIdentity: options.transportIdentity,
    signal: options.signal,
    findProof: options.findProof,
    importProof: options.importProof,
  };
  bindings.set(http, binding);
  return () => {
    binding.activeToken = undefined;
    state.entries.delete(key);
  };
}

function assertScope(binding: Binding): void {
  if (
    scopeKey(
      binding.store,
      binding.tenant,
      binding.profile,
      binding.leaseScope,
      binding.transportIdentity,
    ) !== binding.key
  )
    invalid();
}

export function assertSessionScope(http: HttpClient): void {
  const binding = bindings.get(http);
  if (binding) assertScope(binding);
}

/** Invalidate only the session bound to this runtime's transport scope. */
export function invalidateSharedSession(http: HttpClient): void {
  const binding = bindings.get(http);
  if (!binding) return;
  binding.activeToken = undefined;
  binding.store.entries.delete(binding.key);
}

export function assertSessionCookie(http: HttpClient): void {
  const binding = bindings.get(http);
  if (!binding) return;
  assertScope(binding);
  const current = now(binding.store);
  const entry = binding.store.entries.get(binding.key);
  if (
    entry?.kind !== "ready" ||
    entry.session.token !== binding.activeToken ||
    current < entry.session.receivedAt ||
    current >= entry.session.expiresAt
  )
    invalid();
}

function signalFor(
  runtimeSignal: AbortSignal | undefined,
  connectorSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (
    connectorSignal !== undefined &&
    !(connectorSignal instanceof AbortSignal)
  )
    return invalid();
  // The owner's request must actually receive the signal governing its job.
  if (connectorSignal && runtimeSignal !== connectorSignal) return invalid();
  return runtimeSignal;
}

function abortFailure(binding: Binding, signal: AbortSignal): unknown {
  return binding.profile.abortFailure === "retryable-http"
    ? new ConnectorError("http_error", true)
    : signal.reason;
}

/** Internal bridge: only a runtime-bound HTTP client can access store entries. */
export function sharedBootstrap(
  http: HttpClient,
  load: () => Promise<Bootstrap>,
  tenant: TenantConfig,
  connectorSignal?: AbortSignal,
): Promise<Bootstrap> | undefined {
  const binding = bindings.get(http);
  if (!binding) return undefined;
  if (
    scopeKey(
      binding.store,
      tenant,
      binding.profile,
      binding.leaseScope,
      binding.transportIdentity,
    ) !== binding.key
  )
    return invalid();
  return obtain(binding, load, signalFor(binding.signal, connectorSignal));
}

async function obtain(
  binding: Binding,
  load: () => Promise<Bootstrap>,
  signal: AbortSignal | undefined,
): Promise<Bootstrap> {
  assertScope(binding);
  if (signal?.aborted) throw abortFailure(binding, signal);
  const state = binding.store;
  const current = now(state);
  let entry = state.entries.get(binding.key);
  let ownsPending = false;
  if (
    entry?.kind === "ready" &&
    (current < entry.session.receivedAt || current >= entry.session.expiresAt)
  ) {
    state.entries.delete(binding.key);
    entry = undefined;
  }
  if (!entry) {
    ownsPending = true;
    if (state.entries.size >= state.maxEntries) {
      const oldest = [...state.entries].find(
        ([, item]) => item.kind === "ready",
      );
      if (!oldest) return invalid();
      state.entries.delete(oldest[0]);
    }
    const pending = { kind: "pending" } as Extract<Entry, { kind: "pending" }>;
    pending.promise = (async () => {
      const bootstrap = await load();
      assertScope(binding);
      if (signal?.aborted) throw abortFailure(binding, signal);
      const proof = binding.findProof(bootstrap);
      const jar = binding.profile.cookieJar;
      if (!jar) return invalid();
      const cookie = parseCookieJarWithExpiry(
        proof.headers,
        proof.url,
        proof.endpointPath,
        proof.receivedAt,
        { cookieDomains: jar.cookieDomains },
      );
      if (cookie.header !== bootstrap.cookie) return invalid();
      const receivedAt = Date.parse(proof.receivedAt);
      const expiresAt = Math.min(
        receivedAt + state.maxAgeMs,
        cookie.expiresAt ?? Infinity,
      );
      const checkedAt = now(state);
      if (
        !Number.isFinite(receivedAt) ||
        !Number.isFinite(expiresAt) ||
        checkedAt < receivedAt ||
        checkedAt >= expiresAt ||
        state.entries.get(binding.key) !== pending
      )
        return invalid();
      const session = { token: {}, bootstrap, proof, receivedAt, expiresAt };
      state.entries.set(binding.key, { kind: "ready", session });
      return session;
    })().catch((error: unknown) => {
      if (state.entries.get(binding.key) === pending)
        state.entries.delete(binding.key);
      throw error;
    });
    state.entries.set(binding.key, pending);
    entry = pending;
  }
  const session =
    entry.kind === "ready"
      ? entry.session
      : await (signal && !ownsPending
          ? bounded(entry.promise, signal, () => abortFailure(binding, signal))
          : entry.promise);
  assertScope(binding);
  if (signal?.aborted) throw abortFailure(binding, signal);
  const checkedAt = now(state);
  const currentEntry = state.entries.get(binding.key);
  if (
    checkedAt < session.receivedAt ||
    checkedAt >= session.expiresAt ||
    currentEntry?.kind !== "ready" ||
    currentEntry.session !== session
  )
    return invalid();
  binding.importProof(session.proof);
  binding.activeToken = session.token;
  return {
    ...session.bootstrap,
    cookieValues: [...session.bootstrap.cookieValues],
  };
}
