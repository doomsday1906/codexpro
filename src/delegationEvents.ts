/**
 * Minimal MCP Events transport for durable Codex delegation (Leaf 1).
 *
 * SDK gap: @modelcontextprotocol/sdk 1.17.4 (installed 1.30.0) exposes no
 * `server/discover`, `events/list`, `events/subscribe`, or
 * `events/unsubscribe` methods. This module implements the exact MCP-Events
 * semantics (one narrow `run-attention` event, webhook delivery, deterministic
 * subscription ids, challenge verification) as pure logic plus small webhook
 * I/O, surfaced on the authenticated MCP endpoint as the `events_*` tools
 * until the SDK (or ChatGPT-side subscription support) speaks the protocol
 * methods natively. The mapping is 1:1, so no behavior is invented.
 *
 * Spec: https://developers.openai.com/plugins/build/mcp-events
 *
 * Notification discipline: the event carries run id, state, seq/version, and
 * a sanitized summary or input-request id ONLY. Detail travels exclusively
 * through the authorized read tool. No credentials, transcripts, or
 * instructions ever enter an event or a delivery header.
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import type { DelegationRunState } from "./delegationStore.js";
import { subscriptionsPath } from "./delegationStore.js";

export const RUN_ATTENTION_EVENT = "run-attention";
export const EVENTS_VERSION = "mcp-events/1";
/** JSON-RPC-style error code surfaced when challenge verification fails. */
export const SUBSCRIPTION_CHALLENGE_ERROR_CODE = -32015;

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
  sdkGap: string;
}

export function eventsCapability(): EventsCapability {
  return {
    supported: true,
    via: "tools",
    version: EVENTS_VERSION,
    eventNames: [RUN_ATTENTION_EVENT],
    delivery: "webhook",
    sdkGap: "SDK 1.17.4/1.30.0 has no server/discover or events/* methods; identical semantics are exposed as authenticated events_* tools"
  };
}

export function listRunAttentionEvent(): Record<string, unknown> {
  return {
    name: RUN_ATTENTION_EVENT,
    description: "Narrow delegation wake-up: a canary run reached completed/failed/interrupted/timed_out/cancelled/needs-input. Carries run id, state, seq/version, and a sanitized summary or input-request id only; detail requires an authorized read.",
    delivery: "webhook",
    filters: ["delegationGroup", "runId"],
    fields: ["eventId", "runId", "engine", "delegationGroup", "state", "seq", "version", "summary?", "inputRequestId?", "createdAt"]
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
}): ValidatedSubscription {
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
  if (url.protocol !== "https:") throw new Error("callbackUrl must use https.");
  if (url.username || url.password) throw new Error("callbackUrl must not embed credentials.");
  if (isLoopbackOrPrivateLiteral(url.hostname)) throw new Error("callbackUrl must not target a private or local address.");
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

export function newChallenge(): string {
  return randomBytes(16).toString("hex");
}

async function readBoundedBody(response: Response, maxBytes = 64 * 1024): Promise<string> {
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) throw new Error("callback response too large");
  return buffer.toString("utf8");
}

/**
 * Challenge verification: POST a unique webhook-id + challenge to the
 * callback with Standard Webhooks signing, no redirects. The callback must
 * answer 2xx AND echo the challenge in a JSON `{challenge}` body compared in
 * constant time. Anything else is error -32015.
 */
export async function verifySubscriptionChallenge(
  callbackUrl: string,
  secret: Buffer,
  eventName: string,
  filter: EventFilter,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000
): Promise<{ webhookId: string; challenge: string }> {
  const webhookId = newWebhookId();
  const challenge = newChallenge();
  const body = JSON.stringify({ type: "events.subscribe-challenge", event: eventName, filter, challenge });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(callbackUrl, {
      method: "POST",
      headers: standardWebhookHeaders(webhookId, secret, body),
      body,
      redirect: "manual",
      signal: controller.signal
    });
    if (response.status >= 300 && response.status < 400) {
      throw Object.assign(new Error("callback redirected; redirects are not followed"), { code: SUBSCRIPTION_CHALLENGE_ERROR_CODE });
    }
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(new Error(`challenge callback answered ${response.status}; 2xx required`), { code: SUBSCRIPTION_CHALLENGE_ERROR_CODE });
    }
    let echoed = "";
    try {
      const parsed: unknown = JSON.parse(await readBoundedBody(response));
      echoed = parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? String((parsed as Record<string, unknown>).challenge ?? "")
        : "";
    } catch {
      echoed = "";
    }
    const a = Buffer.from(echoed, "utf8");
    const b = Buffer.from(challenge, "utf8");
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw Object.assign(new Error("challenge echo mismatch (constant-time compare failed)"), { code: SUBSCRIPTION_CHALLENGE_ERROR_CODE });
    }
    return { webhookId, challenge };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === SUBSCRIPTION_CHALLENGE_ERROR_CODE) throw error;
    throw Object.assign(new Error(`challenge verification failed: ${error instanceof Error ? error.message : String(error)}`), { code: SUBSCRIPTION_CHALLENGE_ERROR_CODE });
  } finally {
    clearTimeout(timer);
  }
}

export type DeliveryOutcome =
  | { status: "delivered" }
  | { status: "retryable"; error: string }
  | { status: "permanent"; error: string };

/**
 * Deliver one event to one subscription. 2xx = delivered. 410/413 = permanent
 * (never retried). 3xx = failed without following. 429/5xx + network = retry.
 */
export async function deliverEventToSubscription(
  callbackUrl: string,
  secret: Buffer,
  event: RunAttentionEvent,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 10_000
): Promise<DeliveryOutcome> {
  const webhookId = `wh_evt_${createHash("sha256").update(event.eventId, "utf8").digest("hex").slice(0, 12)}`;
  const body = JSON.stringify({ type: "events.notification", ...event });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(callbackUrl, {
      method: "POST",
      headers: standardWebhookHeaders(webhookId, secret, body),
      body,
      redirect: "manual",
      signal: controller.signal
    });
    if (response.status === 410 || response.status === 413) {
      return { status: "permanent", error: `callback answered ${response.status}; not retried` };
    }
    if (response.status >= 300 && response.status < 400) {
      return { status: "permanent", error: "callback redirected; redirects are never followed" };
    }
    if (response.status >= 200 && response.status < 300) return { status: "delivered" };
    if (response.status === 429 || response.status >= 500) {
      return { status: "retryable", error: `callback answered ${response.status}` };
    }
    return { status: "permanent", error: `callback answered ${response.status}` };
  } catch (error) {
    return { status: "retryable", error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
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
