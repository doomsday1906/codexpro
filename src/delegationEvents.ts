/**
 * Minimal MCP Events transport for durable Codex delegation (Leaf 1).
 *
 * Implements the exact MCP-Events semantics from
 * https://developers.openai.com/plugins/build/mcp-events on the same
 * authenticated MCP endpoint as tools:
 *   server/discover, events/list, events/subscribe, events/unsubscribe
 * (one narrow `run-attention` event, webhook delivery, deterministic
 * subscription ids, challenge verification) as pure logic plus small webhook
 * I/O. The `events_*` tools remain as authenticated compat wrappers that
 * delegate to the real protocol handlers below (1:1, no behavior invented).
 *
 * Notification discipline: the event carries run id, state, seq/version, and
 * a sanitized summary or input-request id ONLY inside `data`. Detail travels
 * exclusively through the authorized read tool. No credentials, transcripts,
 * or instructions ever enter an event or a delivery header.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { DelegationRunState } from "./delegationStore.js";
import { subscriptionsPath } from "./delegationStore.js";

export const RUN_ATTENTION_EVENT = "run-attention";
export const EVENTS_VERSION = "mcp-events/1";
/**
 * Official MCP-Events draft versions advertised by server/discover.
 * Events-draft namespace ONLY: these are not MCP transport protocol versions
 * and must never be sent as the `mcp-protocol-version` transport header.
 * Transport-header compatibility for clients that echo such a value lives in
 * src/http.ts (NEWER_DRAFT_TRANSPORT_VERSION_ALIASES), never here.
 */
export const MCP_EVENTS_SUPPORTED_VERSIONS = ["2026-07-28"] as const;
/** JSON-RPC-style error code surfaced when challenge verification fails. */
export const SUBSCRIPTION_CHALLENGE_ERROR_CODE = -32015;
/** Categorized challenge-failure reasons (data.reason for -32015). */
export const CHALLENGE_FAILURE_REASONS = ["challenge_failed", "timeout", "connection_refused"] as const;
/**
 * Signed-envelope cap: webhook bodies above 256 KiB are refused (outbound
 * deliveries fail permanent; inbound challenge responses fail the challenge).
 * Our envelopes are small JSON; the cap bounds pathological peers/inputs.
 */
export const MAX_ENVELOPE_BYTES = 256 * 1024;
/** Signed-envelope header binding a delivery/challenge to its subscription. */
export const SUBSCRIPTION_ID_HEADER = "X-MCP-Subscription-Id";
/** Default subscription lifetime when ttlMs is omitted (24h). */
export const DEFAULT_SUBSCRIPTION_TTL_MS = 24 * 60 * 60 * 1000;
/** Bounded verification cache TTL (10min) for principal+callback. */
export const VERIFICATION_CACHE_TTL_MS = 10 * 60 * 1000;

/**
 * App-event delivery gate (pump only).
 * Exact opt-in only: CODEXPRO_EVENTS_DELIVERY_ENABLED=1. Verification +
 * subscription storage are ALWAYS allowed (split flags): only app-event
 * POSTs (run-attention deliveries via pump) are gated. Events stay durably
 * replayable via delegation_read_result while disabled. Pure unit functions
 * that take an explicit fetch/post impl express caller intent and are NOT
 * gated; the gate sits at the pump layer only.
 */
export function isEventsDeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.CODEXPRO_EVENTS_DELIVERY_ENABLED ?? "").trim() === "1";
}

/** Alias clarifying the split: only app-event POSTs are gated. */
export function isAppEventDeliveryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isEventsDeliveryEnabled(env);
}

/**
 * Verification + subscription storage are always allowed, even while app
 * delivery is OFF. This split fixes the enable-before-verification order:
 * subscribe verifies + stores first, app deliveries wait for the flag.
 */
export function isSubscriptionStorageAllowed(): boolean {
  return true;
}

/**
 * Hermetic-test-only escape hatch: allows loopback/private callback targets
 * for the loopback wire proof. Never set in production; production refuses
 * private targets fail-closed at connection time (see guardCallbackConnection).
 */
export function eventsAllowPrivateTargets(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.CODEXPRO_EVENTS_ALLOW_PRIVATE ?? "").trim() === "1";
}

export type RunAttentionState = Extract<
  DelegationRunState,
  "completed" | "failed" | "interrupted" | "timed_out" | "cancelled" | "needs-input"
>;

export interface RunAttentionEvent {
  event: typeof RUN_ATTENTION_EVENT;
  eventId: string;
  runId: string;
  engine: string;
  delegationGroup: string;
  state: RunAttentionState;
  seq: number;
  version: number;
  summary?: string;
  inputRequestId?: string;
  createdAt: string;
}

export interface EventFilter {
  delegationGroup?: string;
  runId?: string;
}

export interface EventSubscription {
  version: number;
  subId: string;
  eventName: typeof RUN_ATTENTION_EVENT;
  callbackUrl: string;
  filter: EventFilter;
  ownerIdHash: string;
  ownerKind: "token" | "local";
  createdAt: string;
  /** Webhook id of the last successful challenge; rotated per challenge. */
  lastWebhookId?: string;
  /** Stored whsec_ secret (mode 0600 file) for delivery signing. Never returned. */
  secret: string;
  /** Optional ISO expiry: expired subscriptions stop delivery (permanent). */
  expiresAt?: string;
}

/** Expired subscriptions never receive a POST; delivery ends as permanent. */
export function isSubscriptionExpired(sub: EventSubscription, nowMs: number = Date.now()): boolean {
  if (!sub.expiresAt) return false;
  const parsed = Date.parse(sub.expiresAt);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

export interface EventsCapability {
  supported: boolean;
  via: "tools";
  version: string;
  eventNames: string[];
  delivery: "webhook";
  /** Live app-event POSTs happen only when the explicit delivery flag is set. Verification + storage are always allowed. */
  deliveryEnabled: boolean;
  /** Real MCP-Events protocol methods (tools are compat wrappers delegating to them). */
  methods: {
    discover: string;
    list: string;
    subscribe: string;
    unsubscribe: string;
  };
  /** Signed-envelope headers, including the subscription binding. */
  headers: string[];
  envelopeCapBytes: number;
  tls: string;
  sdkGap: string;
}

export function eventsCapability(): EventsCapability {
  return {
    supported: true,
    via: "tools",
    version: EVENTS_VERSION,
    eventNames: [RUN_ATTENTION_EVENT],
    delivery: "webhook",
    deliveryEnabled: isEventsDeliveryEnabled(),
    methods: {
      discover: "server/discover",
      list: "events/list",
      subscribe: "events/subscribe",
      unsubscribe: "events/unsubscribe"
    },
    headers: ["webhook-id", "webhook-timestamp", "webhook-signature", SUBSCRIPTION_ID_HEADER],
    envelopeCapBytes: MAX_ENVELOPE_BYTES,
    tls: "validated-IP dial with preserved hostname verification + SNI; default TLS, no bypass; redirects never followed",
    sdkGap: "SDK 1.17.4/1.30.0 has no server/discover or events/* natives; identical official semantics are implemented as real protocol handlers in this module and exposed as authenticated events_* compat tools"
  };
}

/**
 * Authoritative DiscoverResult shape provenance (2026-07-28 discover):
 * - Required fields + ttlMs/cacheScope semantics from the base draft schema
 *   $defs/DiscoverResult (required: cacheScope, capabilities, resultType,
 *   supportedVersions, ttlMs):
 *   https://raw.githubusercontent.com/modelcontextprotocol/modelcontextprotocol/main/schema/draft/schema.json
 *   (fetched 2026-10-04; ttlMs = integer >= 0 discovery-response cache hint,
 *   Cache-Control max-age analog — NOT the subscribe lifetime grant;
 *   cacheScope enum "private"|"public", "private" = cacheable only within the
 *   same authorization context).
 * - 2026-07-28 discover example (resultType/supportedVersions/capabilities):
 *   https://developers.openai.com/plugins/build/mcp-events
 * - Subscribe ttlMs suggestion -> refreshBefore grant + principal-bound
 *   subscription identity (subscribe-level TTL, NOT discover fields):
 *   https://github.com/modelcontextprotocol/experimental-ext-triggers-events/blob/main/docs/design-sketch-proposal.md
 *   (draft 2026-02-19).
 *
 * Field values: ttlMs reuses DEFAULT_SUBSCRIPTION_TTL_MS (24h) as the numeric
 * discovery cache hint (static capabilities stay fresh for 24h); cacheScope is
 * "private" so per-owner discovery is cached separately (owner isolation).
 * NOTE: packet paraphrase describing ttlMs as "the subscription lifetime" and
 * cacheScope "e.g. principal" diverges from the authoritative schema — the
 * schema defines ttlMs as the discover cache hint and allows only
 * "private"|"public" ("principal" is not a valid enum value). Implementation
 * follows the authoritative schema; see DISPATCH_SOURCE_CONFLICT note.
 */
export function serverDiscoverResult(): Record<string, unknown> {
  return {
    resultType: "complete",
    supportedVersions: [...MCP_EVENTS_SUPPORTED_VERSIONS],
    capabilities: { tools: {}, events: {} },
    ttlMs: DEFAULT_SUBSCRIPTION_TTL_MS,
    cacheScope: "private"
  };
}

export function listRunAttentionEvent(): Record<string, unknown> {
  return {
    name: RUN_ATTENTION_EVENT,
    description: "Narrow delegation wake-up: a delegation run reached completed/failed/interrupted/timed_out/cancelled/needs-input. Carries run id, state, seq/version, and a sanitized summary or input-request id only; detail requires an authorized read.",
    delivery: ["webhook"],
    inputSchema: {
      type: "object",
      properties: {
        delegationGroup: { type: "string", description: "Delegation group id scoping delivery (e.g. hestia-cli-canary)." },
        runId: { type: "string", description: "Exact delegation run id (run_ + 16 hex)." }
      },
      additionalProperties: false
    },
    payloadSchema: {
      type: "object",
      properties: {
        runId: { type: "string" },
        engine: { type: "string" },
        delegationGroup: { type: "string" },
        state: { type: "string" },
        seq: { type: "number" },
        version: { type: "number" },
        summary: { type: "string" },
        inputRequestId: { type: "string" }
      },
      required: ["runId", "engine", "delegationGroup", "state", "seq", "version"],
      additionalProperties: false
    }
  };
}

/** Deterministic canonical JSON: sorted keys, recursive, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Deterministic subscription id from principal + callback + name + args. */
export function deterministicSubscriptionId(
  ownerIdHash: string,
  callbackUrl: string,
  eventName: string,
  filter: EventFilter
): string {
  const digest = createHash("sha256")
    .update(`${ownerIdHash}\n${callbackUrl}\n${eventName}\n${canonicalJson(filter)}`, "utf8")
    .digest("hex")
    .slice(0, 24);
  return `sub_${digest}`;
}

function isLoopbackOrPrivateLiteral(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "localhost." || host.endsWith(".localhost") || host.endsWith(".localhost.")) return true;
  if (host === "0.0.0.0" || host === "::" || host === "::1" || host === "::ffff:127.0.0.1") return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0 || a >= 224) return true;
  }
  if (host.includes(":")) {
    if (host === "::1" || host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  }
  return false;
}

export interface ValidatedSubscription {
  callbackUrl: string;
  eventName: typeof RUN_ATTENTION_EVENT;
  filter: EventFilter;
  secretBytes: Buffer;
}

/** Injectable DNS resolver (tests stub this; production uses dns.lookup). */
export type DnsLookup = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

async function defaultLookupHost(hostname: string): Promise<Array<{ address: string; family: number }>> {
  return dnsLookup(hostname, { all: true });
}

function ipv4Octets(address: string): number[] | null {
  const match = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 255)) return null;
  return octets;
}

/**
 * Connection-time address block: private, loopback, link-local, multicast,
 * unspecified, and documentation/reserved ranges are refused fail-closed.
 * Covers both IPv4 and IPv6 (including v4-mapped IPv6). Hostname TLS
 * verification and SNI are untouched: this guard only decides whether the
 * connection may be attempted, using the default fetch TLS stack.
 */
export function isBlockedIpAddress(address: string): boolean {
  const raw = String(address ?? "").trim();
  const lower = raw.toLowerCase();
  // IPv4-mapped IPv6 (::ffff:a.b.c.d): judge the embedded IPv4 address.
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  const v4 = ipv4Octets(mapped ? mapped[1] : raw);
  if (v4) {
    const [a, b] = v4;
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 0) return true;
    if (a >= 224) return true;
    // Documentation / reserved (never a real callback target).
    if (a === 192 && (b === 0 || b === 2)) return true;
    if (a === 198 && (b === 18 || b === 19 || b === 51 || b === 100)) return true;
    if (a === 203 && b === 0) return true;
    return false;
  }
  const host = lower.replace(/^\[|\]$/g, "").split("%")[0];
  if (!host.includes(":")) return true; // Unparseable literal: fail closed.
  if (host === "::" || host === "::1") return true;
  if (host.startsWith("fe80:")) return true;
  if (host.startsWith("fec0:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  if (host.startsWith("ff")) return true;
  return false;
}

export interface GuardedCallback {
  host: string;
  addresses: string[];
}

/**
 * Connection-time guard for webhook POSTs (challenge + delivery): resolve
 * the callback hostname via DNS and refuse private/loopback/link-local (and
 * other blocked) addresses, including DNS-rebinding targets that no literal
 * check can see. Literal private/local hostnames are refused without DNS.
 * Redirects are never followed (redirect:"manual" at every POST) and TLS
 * hostname verification stays on the default fetch stack. Throws on refusal;
 * delivery callers convert to permanent (fail closed, never retried).
 */
export async function guardCallbackConnection(
  callbackUrl: string,
  deps?: { lookupHost?: DnsLookup; allowPrivate?: boolean }
): Promise<GuardedCallback> {
  const allowPrivate = deps?.allowPrivate ?? eventsAllowPrivateTargets();
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new Error("callbackUrl must be an absolute URL.");
  }
  if (url.protocol !== "https:" && !allowPrivate) {
    throw new Error("callbackUrl must use https.");
  }
  if (isLoopbackOrPrivateLiteral(url.hostname) && !allowPrivate) {
    throw new Error(`callback host ${url.hostname} is private/local; refused without DNS.`);
  }
  let records: Array<{ address: string; family: number }>;
  try {
    records = await (deps?.lookupHost ?? defaultLookupHost)(url.hostname);
  } catch (error) {
    throw new Error(`callback host ${url.hostname} did not resolve; refusing connection (${error instanceof Error ? error.message : String(error)})`);
  }
  const addresses = records.map((record) => String(record.address));
  if (addresses.length === 0) throw new Error(`callback host ${url.hostname} resolved to no addresses; refusing connection.`);
  if (!allowPrivate) {
    for (const address of addresses) {
      if (isBlockedIpAddress(address)) {
        throw new Error(`callback host ${url.hostname} resolved to blocked address ${address}; private/loopback/link-local refused.`);
      }
    }
  }
  return { host: url.hostname, addresses };
}

/**
 * Validate a subscription request. Rejects: non-HTTPS callbacks,
 * private/local targets, non-run-attention names, over-broad filters, and
 * weak/missing whsec_ secrets (24-64 bytes of entropy after the prefix).
 */
export function validateSubscriptionInput(input: {
  callbackUrl: unknown;
  eventName: unknown;
  filter?: unknown;
  webhookSecret: unknown;
}, opts?: { allowPrivate?: boolean }): ValidatedSubscription {
  const allowPrivate = opts?.allowPrivate ?? eventsAllowPrivateTargets();
  if (input.eventName !== RUN_ATTENTION_EVENT) {
    throw new Error(`Only the narrow ${RUN_ATTENTION_EVENT} event is supported.`);
  }
  if (typeof input.callbackUrl !== "string" || !input.callbackUrl) {
    throw new Error("callbackUrl is required.");
  }
  let url: URL;
  try {
    url = new URL(input.callbackUrl);
  } catch {
    throw new Error("callbackUrl must be an absolute URL.");
  }
  if (url.protocol !== "https:" && !allowPrivate) throw new Error("callbackUrl must use https.");
  if (url.username || url.password) throw new Error("callbackUrl must not embed credentials.");
  if (!allowPrivate && isLoopbackOrPrivateLiteral(url.hostname)) throw new Error("callbackUrl must not target a private or local address.");
  const filter: EventFilter = {};
  if (input.filter !== undefined) {
    if (!input.filter || typeof input.filter !== "object" || Array.isArray(input.filter)) {
      throw new Error("filter must be an object with optional delegationGroup/runId.");
    }
    const raw = input.filter as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (key !== "delegationGroup" && key !== "runId") throw new Error(`Unknown filter key: ${key}.`);
    }
    if (raw.delegationGroup !== undefined) {
      if (typeof raw.delegationGroup !== "string" || !raw.delegationGroup) throw new Error("filter.delegationGroup must be a non-empty string.");
      filter.delegationGroup = raw.delegationGroup;
    }
    if (raw.runId !== undefined) {
      if (typeof raw.runId !== "string" || !/^run_[0-9a-f]{16}$/.test(raw.runId)) throw new Error("filter.runId must be a delegation run id.");
      filter.runId = raw.runId;
    }
  }
  if (typeof input.webhookSecret !== "string" || !input.webhookSecret.startsWith("whsec_")) {
    throw new Error("webhookSecret must start with whsec_.");
  }
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(input.webhookSecret.slice("whsec_".length), "base64");
  } catch {
    throw new Error("webhookSecret is not valid base64 after whsec_.");
  }
  if (secretBytes.length < 24 || secretBytes.length > 64) {
    throw new Error("webhookSecret must carry 24-64 bytes of entropy.");
  }
  return { callbackUrl: url.toString(), eventName: RUN_ATTENTION_EVENT, filter, secretBytes };
}

/** Standard Webhooks signing: v1,HMAC_SHA256(secret, `${id}.${ts}.${body}`) base64. */
export function standardWebhookHeaders(webhookId: string, secret: Buffer, body: string, timestampSeconds?: number): Record<string, string> {
  const ts = String(timestampSeconds ?? Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${webhookId}.${ts}.${body}`, "utf8").digest("base64");
  return {
    "webhook-id": webhookId,
    "webhook-timestamp": ts,
    "webhook-signature": `v1,${signature}`,
    "content-type": "application/json"
  };
}

export function newWebhookId(): string {
  return `wh_${randomBytes(12).toString("hex")}`;
}

/** Official verification webhook-id (unique per challenge). */
export function newVerificationWebhookId(): string {
  return `msg_verification_${randomBytes(12).toString("hex")}`;
}

export function newChallenge(): string {
  return randomBytes(16).toString("hex");
}

/** Official challenge body: exactly {type:"verification", challenge}. */
export function buildVerificationBody(challenge: string): string {
  return JSON.stringify({ type: "verification", challenge });
}

/** Official event body: {eventId,name,timestamp,data,cursor}. */
export function buildEventBody(event: RunAttentionEvent): string {
  const { eventId, runId, engine, delegationGroup, state, seq, version, summary, inputRequestId, createdAt } = event;
  const data: Record<string, unknown> = {
    runId, engine, delegationGroup, state, seq, version,
    ...(summary !== undefined ? { summary } : {}),
    ...(inputRequestId !== undefined ? { inputRequestId } : {})
  };
  return JSON.stringify({
    eventId,
    name: event.event,
    timestamp: createdAt,
    data,
    cursor: null
  });
}

/** Delivery webhook-id is the eventId itself (preserved across retries). */
export function deliveryWebhookId(event: RunAttentionEvent): string {
  return event.eventId;
}

// ---------- Verification cache (principal+callback, bounded 10min) ----------
const verificationCache = new Map<string, number>();
export function verificationCacheKey(ownerIdHash: string, callbackUrl: string): string {
  return `${ownerIdHash}\n${callbackUrl}`;
}
export function isVerificationCached(ownerIdHash: string, callbackUrl: string, nowMs = Date.now()): boolean {
  const until = verificationCache.get(verificationCacheKey(ownerIdHash, callbackUrl));
  return typeof until === "number" && until > nowMs;
}
export function markVerificationCached(ownerIdHash: string, callbackUrl: string, nowMs = Date.now()): void {
  verificationCache.set(verificationCacheKey(ownerIdHash, callbackUrl), nowMs + VERIFICATION_CACHE_TTL_MS);
}
export function clearVerificationCache(): void {
  verificationCache.clear();
}

// ---------- Validated-IP POST (no second unvalidated resolve, SNI preserved) ----------
export interface ValidatedTarget {
  protocol: "https:" | "http:";
  hostname: string;
  port: number;
  path: string;
  ip: string;
  hostHeader: string;
  servername: string;
}

export interface ValidatedPostResult {
  status: number;
  bodyText: string;
}

export type ValidatedPostImpl = (
  target: ValidatedTarget,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number
) => Promise<ValidatedPostResult>;

function defaultPortFor(protocol: string): number {
  return protocol === "https:" ? 443 : 80;
}

export async function resolveValidatedTarget(
  callbackUrl: string,
  opts?: { lookupHost?: DnsLookup; allowPrivate?: boolean }
): Promise<ValidatedTarget> {
  const guarded = await guardCallbackConnection(callbackUrl, { lookupHost: opts?.lookupHost, allowPrivate: opts?.allowPrivate });
  const url = new URL(callbackUrl);
  const protocol = url.protocol as "https:" | "http:";
  const port = url.port ? Number(url.port) : defaultPortFor(protocol);
  const ip = guarded.addresses[0];
  const hostHeader = url.host;
  return {
    protocol,
    hostname: url.hostname,
    port,
    path: `${url.pathname}${url.search}`,
    ip,
    hostHeader,
    servername: url.hostname
  };
}

function productionPostImpl(
  target: ValidatedTarget,
  body: string,
  headers: Record<string, string>,
  timeoutMs: number
): Promise<ValidatedPostResult> {
  return new Promise((resolve, reject) => {
    const lib = target.protocol === "https:" ? https : http;
    const urlHost = target.ip.includes(":") && !target.ip.startsWith("[") ? `[${target.ip}]` : target.ip;
    const req = lib.request(
      {
        hostname: target.ip,
        port: target.port,
        path: target.path,
        method: "POST",
        headers: { ...headers, Host: target.hostHeader },
        ...(target.protocol === "https:"
          ? { servername: target.servername, rejectUnauthorized: true }
          : {}),
        agent: undefined
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        res.on("data", (chunk: Buffer) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buf.byteLength;
          if (bytes <= MAX_ENVELOPE_BYTES + 1024) chunks.push(buf);
        });
        res.on("end", () => {
          const buffer = Buffer.concat(chunks);
          if (buffer.byteLength > MAX_ENVELOPE_BYTES) {
            reject(new Error("callback response exceeds the 256 KiB envelope cap"));
            return;
          }
          resolve({ status: res.statusCode ?? 0, bodyText: buffer.toString("utf8") });
        });
        res.on("error", reject);
      }
    );
    void urlHost;
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("webhook POST timed out"));
    });
    req.end(body, "utf8");
  });
}

async function readBoundedBody(response: Response, maxBytes = MAX_ENVELOPE_BYTES): Promise<string> {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error("callback response exceeds the 256 KiB envelope cap");
  return buffer.toString("utf8");
}

/**
 * POST via validated IP while preserving TLS hostname + SNI.
 * - Resolves + validates ONCE (guard), then dials the validated IP literal
 *   (no second unvalidated resolve of the hostname).
 * - Preserves Host header + TLS servername (SNI) + default hostname
 *   verification; never bypasses certificates, never follows redirects.
 * - `postImpl` is the hermetic injection point (asserts ip/host/servername);
 *   production uses https/http with servername. Legacy `fetchImpl` stubs are
 *   adapted to the validated IP URL for compat (http loopback + unit stubs).
 */
export async function postValidatedWebhook(
  callbackUrl: string,
  body: string,
  headers: Record<string, string>,
  opts: {
    timeoutMs?: number;
    lookupHost?: DnsLookup;
    allowPrivate?: boolean;
    postImpl?: ValidatedPostImpl;
    fetchImpl?: typeof fetch;
  } = {}
): Promise<ValidatedPostResult> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const target = await resolveValidatedTarget(callbackUrl, {
    lookupHost: opts.lookupHost,
    allowPrivate: opts.allowPrivate
  });
  if (opts.postImpl) {
    return opts.postImpl(target, body, { ...headers, Host: target.hostHeader }, timeoutMs);
  }
  const fetchImpl = opts.fetchImpl ?? fetch;
  const isDefaultFetch = fetchImpl === fetch;
  if (isDefaultFetch) {
    return productionPostImpl(target, body, headers, timeoutMs);
  }
  // Legacy stub path (hermetic unit + http loopback): call the stub with the
  // VALIDATED IP URL (no hostname re-resolve) and preserved Host header.
  const ipHost = target.ip.includes(":") && !target.ip.startsWith("[") ? `[${target.ip}]` : target.ip;
  const defaultPort = target.protocol === "https:" ? 443 : 80;
  const portSuffix = target.port === defaultPort ? "" : `:${target.port}`;
  const ipUrl = `${target.protocol}//${ipHost}${portSuffix}${target.path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(ipUrl, {
      method: "POST",
      headers: { ...headers, Host: target.hostHeader },
      body,
      redirect: "manual",
      signal: controller.signal
    });
    const bodyText = await readBoundedBody(response);
    return { status: response.status, bodyText };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Challenge verification (official envelope): POST {type:"verification",
 * challenge} with a unique msg_verification_* webhook-id + Standard Webhooks
 * signing + X-MCP-Subscription-Id, via validated IP (Host + SNI preserved),
 * no redirects. The callback must answer 2xx AND echo the challenge in a JSON
 * `{challenge}` body compared in constant time. Anything else is error -32015
 * with categorized data.reason (challenge_failed/timeout/connection_refused).
 */
export async function verifySubscriptionChallenge(
  callbackUrl: string,
  secret: Buffer,
  eventName: string,
  filter: EventFilter,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
  extra?: {
    subId?: string;
    lookupHost?: DnsLookup;
    allowPrivate?: boolean;
    postImpl?: ValidatedPostImpl;
    reason?: string;
  }
): Promise<{ webhookId: string; challenge: string }> {
  void eventName;
  void filter;
  const webhookId = newVerificationWebhookId();
  const challenge = newChallenge();
  const body = buildVerificationBody(challenge);
  if (Buffer.byteLength(body, "utf8") > MAX_ENVELOPE_BYTES) {
    throw Object.assign(new Error("challenge envelope exceeds the 256 KiB cap"), {
      code: SUBSCRIPTION_CHALLENGE_ERROR_CODE,
      data: { reason: "challenge_failed" }
    });
  }
  const headers: Record<string, string> = {
    ...standardWebhookHeaders(webhookId, secret, body),
    ...(extra?.subId ? { [SUBSCRIPTION_ID_HEADER]: extra.subId } : {})
  };
  let status = 0;
  let bodyText = "";
  try {
    // Single validated resolve inside postValidatedWebhook (no second
    // unvalidated resolve): lookup -> validate -> dial IP with Host+SNI.
    const result = await postValidatedWebhook(callbackUrl, body, headers, {
      timeoutMs,
      lookupHost: extra?.lookupHost,
      allowPrivate: extra?.allowPrivate,
      postImpl: extra?.postImpl,
      fetchImpl
    });
    status = result.status;
    bodyText = result.bodyText;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const reason = /timed out|abort/i.test(message) ? "timeout" : "connection_refused";
    throw Object.assign(new Error(`challenge verification failed: ${message}`), {
      code: SUBSCRIPTION_CHALLENGE_ERROR_CODE,
      data: { reason }
    });
  }
  if (status >= 300 && status < 400) {
    throw Object.assign(new Error("callback redirected; redirects are not followed"), {
      code: SUBSCRIPTION_CHALLENGE_ERROR_CODE,
      data: { reason: "challenge_failed" }
    });
  }
  if (status < 200 || status >= 300) {
    throw Object.assign(new Error(`challenge callback answered ${status}; 2xx required`), {
      code: SUBSCRIPTION_CHALLENGE_ERROR_CODE,
      data: { reason: "challenge_failed" }
    });
  }
  let echoed = "";
  try {
    if (Buffer.byteLength(bodyText, "utf8") > MAX_ENVELOPE_BYTES) throw new Error("cap");
    const parsed: unknown = JSON.parse(bodyText);
    echoed = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? String((parsed as Record<string, unknown>).challenge ?? "")
      : "";
  } catch {
    echoed = "";
  }
  const a = Buffer.from(echoed, "utf8");
  const b = Buffer.from(challenge, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw Object.assign(new Error("challenge echo mismatch (constant-time compare failed)"), {
      code: SUBSCRIPTION_CHALLENGE_ERROR_CODE,
      data: { reason: "challenge_failed" }
    });
  }
  return { webhookId, challenge };
}

export type DeliveryOutcome =
  | { status: "delivered" }
  | { status: "retryable"; error: string }
  | { status: "permanent"; error: string };

/**
 * Deliver one event to one subscription (official envelope):
 * POST {eventId,name,timestamp,data,cursor} with webhook-id = eventId
 * (preserved across retries), fresh timestamp+signature per attempt, plus
 * X-MCP-Subscription-Id, via validated IP (Host + SNI preserved), no
 * redirects. 2xx = delivered. 410/413 = permanent (never retried).
 * 3xx = permanent without following. 429/5xx + network = retry.
 * Blocked DNS resolutions are permanent (fail closed, no POST). Envelopes
 * above the 256 KiB cap are permanent.
 */
export async function deliverEventToSubscription(
  callbackUrl: string,
  secret: Buffer,
  event: RunAttentionEvent,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000,
  extra?: { subId?: string; lookupHost?: DnsLookup; allowPrivate?: boolean; postImpl?: ValidatedPostImpl }
): Promise<DeliveryOutcome> {
  const webhookId = deliveryWebhookId(event);
  const body = buildEventBody(event);
  if (Buffer.byteLength(body, "utf8") > MAX_ENVELOPE_BYTES) {
    return { status: "permanent", error: "envelope exceeds the 256 KiB cap; not retried" };
  }
  const headers: Record<string, string> = {
    ...standardWebhookHeaders(webhookId, secret, body),
    ...(extra?.subId ? { [SUBSCRIPTION_ID_HEADER]: extra.subId } : {})
  };
  let posted: ValidatedPostResult;
  try {
    posted = await postValidatedWebhook(callbackUrl, body, headers, {
      timeoutMs,
      lookupHost: extra?.lookupHost,
      allowPrivate: extra?.allowPrivate,
      postImpl: extra?.postImpl,
      fetchImpl
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // DNS/validation refusal is fail-closed permanent (never retried);
    // network/timeout is retryable.
    if (/refused|blocked|private|local|did not resolve|no addresses|must use https|absolute URL/i.test(message)) {
      return { status: "permanent", error: message };
    }
    return { status: "retryable", error: message };
  }
  const status = posted.status;
  if (status === 410 || status === 413) {
    return { status: "permanent", error: `callback answered ${status}; not retried` };
  }
  if (status >= 300 && status < 400) {
    return { status: "permanent", error: "callback redirected; redirects are never followed" };
  }
  if (status >= 200 && status < 300) return { status: "delivered" };
  if (status === 429 || status >= 500) {
    return { status: "retryable", error: `callback answered ${status}` };
  }
  return { status: "permanent", error: `callback answered ${status}` };
}

/** Retry backoff: 1s, 2s, 4s ... capped at 5 minutes. No retry for 410/413. */
export function nextRetryDelayMs(failedAttempts: number): number {
  const n = Math.max(0, Math.floor(failedAttempts));
  return Math.min(300_000, 1_000 * 2 ** Math.min(n, 8));
}

export function subscriptionMatches(sub: EventSubscription, event: { delegationGroup: string; runId: string }): boolean {
  if (sub.filter.delegationGroup !== undefined && sub.filter.delegationGroup !== event.delegationGroup) return false;
  if (sub.filter.runId !== undefined && sub.filter.runId !== event.runId) return false;
  return true;
}

/**
 * Constant-time owner check between a run record and a subscription.
 * Knowing a group, run, or subscription id grants no access: a delivery
 * target is selected only when the subscription owner's hash AND kind match
 * the run owner's. Used both when selecting targets (enqueue/replay) and as
 * a fail-closed recheck at pump time.
 */
export function subscriptionOwnerMatchesRecord(
  ownerIdHash: string,
  ownerKind: "token" | "local",
  sub: Pick<EventSubscription, "ownerIdHash" | "ownerKind">
): boolean {
  if (ownerKind !== sub.ownerKind) return false;
  const a = Buffer.from(ownerIdHash, "utf8");
  const b = Buffer.from(sub.ownerIdHash, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function loadSubscriptions(bridgeDir: string): EventSubscription[] {
  let raw: string;
  try {
    raw = fs.readFileSync(subscriptionsPath(bridgeDir), "utf8");
  } catch {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as { subscriptions?: unknown }).subscriptions)) return [];
    return (parsed as { subscriptions: EventSubscription[] }).subscriptions.filter(
      (sub) => sub && typeof sub.subId === "string" && sub.eventName === RUN_ATTENTION_EVENT
    );
  } catch {
    return [];
  }
}

export function saveSubscriptions(bridgeDir: string, subscriptions: EventSubscription[]): void {
  const dir = bridgeDir;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = subscriptionsPath(bridgeDir);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, subscriptions }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

// ---------- Real MCP-Events JSON-RPC handlers (official shapes) ----------
export interface EventsSubscribeParams {
  name: unknown;
  arguments?: unknown;
  args?: unknown;
  filter?: unknown;
  delivery: { mode?: unknown; url?: unknown; callbackUrl?: unknown; secret?: unknown; webhookSecret?: unknown };
  cursor?: unknown;
  ttlMs?: unknown;
}

export interface EventsUnsubscribeParams {
  name: unknown;
  arguments?: unknown;
  args?: unknown;
  filter?: unknown;
  delivery: { mode?: unknown; url?: unknown; callbackUrl?: unknown };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Translate official subscribe params to validated input (accepts compat aliases). */
export function translateSubscribeParams(params: EventsSubscribeParams): {
  validated: ValidatedSubscription;
  rawSecret: string;
  ttlMs: number | null | undefined;
  cursor: string | null;
} {
  const raw = asRecord(params as unknown);
  const name = raw.name;
  const args = (raw.arguments ?? raw.args ?? raw.filter ?? {}) as unknown;
  const delivery = asRecord(raw.delivery);
  const url = delivery.url ?? delivery.callbackUrl;
  const secret = delivery.secret ?? delivery.webhookSecret;
  const mode = delivery.mode ?? "webhook";
  if (mode !== "webhook") throw new Error("delivery.mode must be webhook.");
  const filterInput = args && typeof args === "object" && !Array.isArray(args)
    ? Object.fromEntries(
        Object.entries(args as Record<string, unknown>).map(([k, v]) => {
          if (k === "delegation_group") return ["delegationGroup", v];
          if (k === "run_id") return ["runId", v];
          return [k, v];
        })
      )
    : {};
  const validated = validateSubscriptionInput({
    callbackUrl: url,
    eventName: name,
    filter: filterInput,
    webhookSecret: secret
  });
  if (typeof secret !== "string" || !secret.startsWith("whsec_")) throw new Error("delivery.secret must start with whsec_.");
  let ttlMs: number | null | undefined;
  if (raw.ttlMs === null) ttlMs = null;
  else if (raw.ttlMs === undefined) ttlMs = undefined;
  else {
    const n = Number(raw.ttlMs);
    if (!Number.isFinite(n) || n < 0) throw new Error("ttlMs must be a non-negative number or null.");
    ttlMs = Math.floor(n);
  }
  const cursor = raw.cursor === undefined || raw.cursor === null ? null : String(raw.cursor);
  return { validated, rawSecret: secret, ttlMs, cursor };
}

export function translateUnsubscribeParams(params: EventsUnsubscribeParams): ValidatedSubscriptionInputForUnsub {
  const raw = asRecord(params as unknown);
  const name = raw.name;
  if (name !== RUN_ATTENTION_EVENT) throw new Error(`Only the narrow ${RUN_ATTENTION_EVENT} event is supported.`);
  const args = (raw.arguments ?? raw.args ?? raw.filter ?? {}) as unknown;
  const delivery = asRecord(raw.delivery);
  const url = delivery.url ?? delivery.callbackUrl;
  if (typeof url !== "string" || !url) throw new Error("delivery.url is required.");
  let urlObj: URL;
  try {
    urlObj = new URL(url);
  } catch {
    throw new Error("delivery.url must be an absolute URL.");
  }
  const filter: EventFilter = {};
  if (args !== undefined) {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("arguments must be an object.");
    const rec = args as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      const norm = key === "delegation_group" ? "delegationGroup" : key === "run_id" ? "runId" : key;
      if (norm !== "delegationGroup" && norm !== "runId") throw new Error(`Unknown arguments key: ${key}.`);
      if (norm === "delegationGroup" && rec[key] !== undefined) {
        if (typeof rec[key] !== "string" || !(rec[key] as string)) throw new Error("arguments.delegationGroup must be a non-empty string.");
        filter.delegationGroup = rec[key] as string;
      }
      if (norm === "runId" && rec[key] !== undefined) {
        if (typeof rec[key] !== "string" || !/^run_[0-9a-f]{16}$/.test(rec[key] as string)) throw new Error("arguments.runId must be a delegation run id.");
        filter.runId = rec[key] as string;
      }
    }
  }
  return { callbackUrl: urlObj.toString(), eventName: RUN_ATTENTION_EVENT, filter };
}

export interface ValidatedSubscriptionInputForUnsub {
  callbackUrl: string;
  eventName: typeof RUN_ATTENTION_EVENT;
  filter: EventFilter;
}

export function handleServerDiscover(): Record<string, unknown> {
  return serverDiscoverResult();
}

export function handleEventsList(cursor?: unknown): Record<string, unknown> {
  void cursor;
  return { events: [listRunAttentionEvent()], nextCursor: undefined };
}

export interface SubscribeHandlerDeps {
  bridgeDir: string;
  ownerIdHash: string;
  ownerKind?: "token" | "local";
  lookupHost?: DnsLookup;
  allowPrivate?: boolean;
  postImpl?: ValidatedPostImpl;
  fetchImpl?: typeof fetch;
}

export interface SubscribeHandlerResult {
  id: string;
  refreshBefore: string | null;
  cursor: null;
  truncated: false;
  idempotent: boolean;
  cachedVerification: boolean;
}

export async function handleEventsSubscribe(
  params: EventsSubscribeParams,
  deps: SubscribeHandlerDeps
): Promise<SubscribeHandlerResult> {
  const { validated, rawSecret, ttlMs } = translateSubscribeParams(params);
  const subId = deterministicSubscriptionId(deps.ownerIdHash, validated.callbackUrl, validated.eventName, validated.filter);
  const existing = loadSubscriptions(deps.bridgeDir).find((s) => s.subId === subId);
  // Bounded verification cache: same principal+callback recently verified
  // skips a repeat challenge (official behavior).
  const cached = isVerificationCached(deps.ownerIdHash, validated.callbackUrl);
  let webhookId: string | undefined;
  if (!(cached && existing)) {
    const verified = await verifySubscriptionChallenge(
      validated.callbackUrl,
      validated.secretBytes,
      validated.eventName,
      validated.filter,
      deps.fetchImpl ?? fetch,
      10_000,
      { subId, lookupHost: deps.lookupHost, allowPrivate: deps.allowPrivate, postImpl: deps.postImpl }
    ).catch((error) => {
      const code = error && typeof error === "object" && "code" in error
        ? Number((error as { code?: unknown }).code)
        : SUBSCRIPTION_CHALLENGE_ERROR_CODE;
      const reason = error && typeof error === "object" && (error as { data?: unknown }).data
        ? String(((error as { data: { reason?: unknown } }).data.reason ?? "challenge_failed"))
        : "challenge_failed";
      throw Object.assign(
        new Error(`Subscription challenge failed: ${error instanceof Error ? error.message : String(error)}`),
        { code: Number.isFinite(code) ? code : SUBSCRIPTION_CHALLENGE_ERROR_CODE, data: { reason } }
      );
    });
    webhookId = verified.webhookId;
    markVerificationCached(deps.ownerIdHash, validated.callbackUrl);
  } else {
    webhookId = existing?.lastWebhookId;
  }
  // Expiration: ttlMs null => no expiration; number => grant at most requested;
  // omitted => server default 24h.
  let expiresAt: string | undefined;
  let refreshBefore: string | null;
  if (ttlMs === null) {
    expiresAt = undefined;
    refreshBefore = null;
  } else {
    const grantMs = ttlMs === undefined ? DEFAULT_SUBSCRIPTION_TTL_MS : Math.min(ttlMs, 30 * 24 * 60 * 60 * 1000);
    // Enforce a 60s minimum to prevent excessive refresh requests, but never
    // grant more than requested (except this minimum floor).
    const floorMs = 60_000;
    const effective = ttlMs === undefined ? grantMs : Math.max(Math.min(grantMs, ttlMs), Math.min(floorMs, ttlMs));
    expiresAt = new Date(Date.now() + effective).toISOString();
    refreshBefore = expiresAt;
  }
  const subs = loadSubscriptions(deps.bridgeDir);
  const index = subs.findIndex((s) => s.subId === subId);
  const record: EventSubscription = {
    version: 1,
    subId,
    eventName: validated.eventName,
    callbackUrl: validated.callbackUrl,
    filter: validated.filter,
    ownerIdHash: deps.ownerIdHash,
    ownerKind: deps.ownerKind ?? (index >= 0 ? subs[index].ownerKind : "token"),
    createdAt: index >= 0 ? subs[index].createdAt : new Date().toISOString(),
    ...(webhookId ? { lastWebhookId: webhookId } : {}),
    secret: rawSecret,
    ...(expiresAt ? { expiresAt } : {})
  };
  if (index >= 0) subs[index] = record;
  else subs.push(record);
  saveSubscriptions(deps.bridgeDir, subs);
  return { id: subId, refreshBefore, cursor: null, truncated: false, idempotent: index >= 0, cachedVerification: cached && Boolean(existing) };
}

export function handleEventsUnsubscribe(
  params: EventsUnsubscribeParams,
  deps: { bridgeDir: string; ownerIdHash: string }
): { removed: boolean } {
  const translated = translateUnsubscribeParams(params);
  const subId = deterministicSubscriptionId(deps.ownerIdHash, translated.callbackUrl, translated.eventName, translated.filter);
  const subs = loadSubscriptions(deps.bridgeDir);
  const index = subs.findIndex((s) => s.subId === subId);
  if (index < 0) return { removed: false };
  if (subs[index].ownerIdHash !== deps.ownerIdHash) return { removed: false };
  subs.splice(index, 1);
  saveSubscriptions(deps.bridgeDir, subs);
  return { removed: true };
}
