/**
 * Real MCP-Events JSON-RPC dispatcher for the authenticated MCP endpoint.
 *
 * The `events_*` compat tools delegate to the same official protocol handlers
 * in delegationEvents.ts; this module exposes those handlers as real
 * JSON-RPC methods on the MCP wire:
 *   server/discover, events/list, events/subscribe, events/unsubscribe
 *
 * HTTP (`src/http.ts` POST /mcp) intercepts a protocol-method body BEFORE
 * `transport.handleRequest` (after the existing bearer-token gate, so every
 * protocol call is auth-checked) and answers the JSON-RPC envelope directly.
 * Stdio (`src/stdio.ts`) wraps the connected transport's onmessage with the
 * same single-message dispatcher. Non-protocol traffic always falls through
 * to the ordinary SDK transport untouched.
 *
 * Owner/bridge binding matches the compat tools: the owner id is recomputed
 * from the CURRENT server credentials (bearer token or local uid+root) and
 * subscriptions persist under the canonical subscription authority dir
 * (server defaultRoot bridge). Knowing a group, run, or subscription id
 * grants no access. Completion delivery lookup reads this SAME authority dir
 * (never the run workspace bridge), so a subscription is visible to runs in
 * every permitted workspace; run state itself stays in the run workspace.
 */

import type { CodexProConfig } from "./config.js";
import { authorityBridgeDirFor, ownerIdFor } from "./delegationStore.js";
import {
  handleEventsList,
  handleEventsSubscribe,
  handleEventsUnsubscribe,
  handleServerDiscover,
  SUBSCRIPTION_CHALLENGE_ERROR_CODE
} from "./delegationEvents.js";

export const DELEGATION_PROTOCOL_METHODS = [
  "server/discover",
  "events/list",
  "events/subscribe",
  "events/unsubscribe"
] as const;

export type DelegationProtocolMethod = (typeof DELEGATION_PROTOCOL_METHODS)[number];

export function isDelegationProtocolMethod(method: unknown): method is DelegationProtocolMethod {
  return typeof method === "string" &&
    (DELEGATION_PROTOCOL_METHODS as readonly string[]).includes(method);
}

export interface DelegationProtocolContext {
  config: CodexProConfig;
}

function localOwnerIdFor(config: CodexProConfig): string {
  const uid = typeof process.getuid === "function" ? String(process.getuid()) : "unknown";
  return `${uid}:${config.defaultRoot}`;
}

function bridgeDirFor(config: CodexProConfig): string {
  // Canonical subscription authority: the server defaultRoot bridge dir,
  // shared across all permitted workspaces (run state stays per-workspace).
  return authorityBridgeDirFor(config.defaultRoot, config.contextDir);
}

function asParamsRecord(params: unknown): Record<string, unknown> {
  return params !== null && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
}

function jsonRpcError(id: unknown, code: number, message: string, data?: unknown): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: id ?? null,
    error: {
      code,
      message,
      ...(data !== undefined ? { data } : {})
    }
  };
}

function sanitizeErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error ?? fallback);
  return message.slice(0, 512) || fallback;
}

/**
 * Dispatch one JSON-RPC message to the real protocol handlers. Returns the
 * JSON-RPC response object, or null when the message is a notification (no
 * id: executed without a response, never a side-effecting subscribe) or is
 * not a delegation protocol method (caller falls through to the transport).
 * Never throws for protocol methods: failures become JSON-RPC errors.
 */
export async function handleDelegationProtocolMessage(
  message: unknown,
  ctx: DelegationProtocolContext
): Promise<Record<string, unknown> | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) return null;
  const envelope = message as { method?: unknown; params?: unknown; id?: unknown };
  if (!isDelegationProtocolMethod(envelope.method)) return null;
  const method = envelope.method;
  const hasId = Object.hasOwn(envelope, "id") && envelope.id !== undefined;
  if (!hasId) return null;
  const id = (envelope.id ?? null) as unknown;
  const params = envelope.params === undefined ? {} : envelope.params;
  if (params !== undefined && (params === null || typeof params !== "object" || Array.isArray(params))) {
    return jsonRpcError(id, -32602, "Invalid params: params must be an object when present.");
  }
  const args = asParamsRecord(params);

  try {
    switch (method) {
      case "server/discover": {
        return { jsonrpc: "2.0", id, result: handleServerDiscover() };
      }
      case "events/list": {
        const cursor = args.cursor === undefined ? undefined : args.cursor;
        return { jsonrpc: "2.0", id, result: handleEventsList(cursor) };
      }
      case "events/subscribe": {
        const owner = ownerIdFor(ctx.config.authToken, localOwnerIdFor(ctx.config));
        const result = await handleEventsSubscribe(args as never, {
          bridgeDir: bridgeDirFor(ctx.config),
          ownerIdHash: owner.ownerIdHash,
          ownerKind: owner.ownerKind
        });
        return { jsonrpc: "2.0", id, result };
      }
      case "events/unsubscribe": {
        const owner = ownerIdFor(ctx.config.authToken, localOwnerIdFor(ctx.config));
        const result = handleEventsUnsubscribe(args as never, {
          bridgeDir: bridgeDirFor(ctx.config),
          ownerIdHash: owner.ownerIdHash
        });
        return { jsonrpc: "2.0", id, result };
      }
    }
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? Number((error as { code?: unknown }).code)
      : Number.NaN;
    if (Number.isFinite(code) && code === SUBSCRIPTION_CHALLENGE_ERROR_CODE) {
      const reason = error && typeof error === "object" && (error as { data?: unknown }).data
        ? String(((error as { data: { reason?: unknown } }).data.reason ?? "challenge_failed"))
        : "challenge_failed";
      return jsonRpcError(id, SUBSCRIPTION_CHALLENGE_ERROR_CODE, sanitizeErrorMessage(error, "Subscription challenge failed."), { reason });
    }
    return jsonRpcError(id, -32602, `Subscription rejected: ${sanitizeErrorMessage(error, "Invalid params.")}`);
  }
  return null;
}

export interface DelegationProtocolBodyOutcome {
  handled: boolean;
  status: number;
  /** Full JSON-RPC response object/array. Undefined for notification-only bodies (202, empty). */
  response?: unknown;
}

function isProtocolBody(message: unknown): boolean {
  return Boolean(message && typeof message === "object" && !Array.isArray(message) &&
    isDelegationProtocolMethod((message as { method?: unknown }).method));
}

/**
 * Endpoint-level entry point: when the parsed POST /mcp body is (or, for
 * batch arrays, consists entirely of) delegation protocol requests, dispatch
 * each to the real handlers and report handled with the JSON-RPC response.
 * Anything else reports handled:false so the caller falls through to
 * `transport.handleRequest` untouched. Never throws.
 */
export async function tryHandleDelegationProtocolBody(
  body: unknown,
  ctx: DelegationProtocolContext
): Promise<DelegationProtocolBodyOutcome> {
  try {
    if (Array.isArray(body)) {
      if (body.length === 0 || !body.every(isProtocolBody)) return { handled: false, status: 200 };
      const responses: unknown[] = [];
      for (const message of body) {
        const response = await handleDelegationProtocolMessage(message, ctx);
        if (response) responses.push(response);
      }
      if (responses.length === 0) return { handled: true, status: 202 };
      return { handled: true, status: 200, response: responses };
    }
    if (!isProtocolBody(body)) return { handled: false, status: 200 };
    const response = await handleDelegationProtocolMessage(body, ctx);
    if (!response) return { handled: true, status: 202 };
    return { handled: true, status: 200, response };
  } catch (error) {
    void error;
    return { handled: false, status: 200 };
  }
}

export interface StdioProtocolTransport {
  // `any` message shapes keep this assignable to the SDK's concrete
  // StdioServerTransport without importing SDK types here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onmessage?: ((message: any) => unknown) | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  send: (message: any) => Promise<void> | void;
}

/**
 * Stdio entry point: wrap a connected transport so delegation protocol
 * methods reach the same real handlers, with all other traffic forwarded to
 * the SDK dispatcher untouched. Never throws.
 */
export function wrapStdioTransportForDelegationProtocol(
  config: CodexProConfig,
  transport: StdioProtocolTransport
): void {
  const inner = transport.onmessage?.bind(transport);
  if (!inner) return;
  transport.onmessage = async (message: unknown): Promise<void> => {
    try {
      if (message && typeof message === "object" && !Array.isArray(message) &&
        isDelegationProtocolMethod((message as { method?: unknown }).method)) {
        const response = await handleDelegationProtocolMessage(message, { config });
        if (response) await transport.send(response);
        return;
      }
    } catch {
      // Fall through to the SDK dispatcher on wrapper failure.
    }
    await inner(message);
  };
}
