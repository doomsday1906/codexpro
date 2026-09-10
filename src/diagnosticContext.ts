import { randomBytes } from "node:crypto";

export type DiagnosticTransportKind = "http" | "stdio" | "in-memory";

export interface HttpDiagnosticCurrentSession {
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly inFlightRequests: number;
}

export interface HttpDiagnosticCurrentRequest {
  /** Number of ordinary HTTP MCP requests currently in flight in this process. */
  readonly inFlightRequests: number;
}

export interface HttpLifecycleEvent {
  readonly seq: number;
  readonly t: number;
  readonly event:
    | "initialize_admitted"
    | "initialize_rejected"
    | "request_finish"
    | "session_not_found"
    | "capacity_evict"
    | "ttl_expire"
    | "transport_close";
  readonly method: string;
  readonly status: number | null;
  readonly durationMs: number | null;
  /** Salted/truncated non-reversible session fingerprint for correlation only. Never a routing id. */
  readonly fp: string | null;
  readonly active: number;
  readonly pending: number;
  readonly reason: string | null;
  readonly completed: number | null;
  readonly idleMs: number | null;
}

export interface HttpDiagnosticSnapshot {
  /** Actual HTTP transport mode for this process, never inferred from config in the server. */
  readonly mode: "stateless" | "retained";
  /** Whether transport-session retention is active for this process. */
  readonly retentionEnabled: boolean;
  /** Configured retained-session settings, even when stateless mode ignores them. */
  readonly configuredMax: number;
  readonly configuredTtlMs: number;
  readonly totalInitializeObservations: number;
  readonly totalOrdinaryRequests: number;
  readonly active: number;
  readonly max: number;
  readonly ttlMs: number;
  readonly totalInitialized: number;
  readonly totalClosed: number;
  readonly totalExpired: number;
  readonly totalCapacityEvicted: number;
  readonly idle: number;
  readonly inFlightSessions: number;
  readonly inFlightRequests: number;
  /** Process-wide ordinary HTTP MCP requests currently in flight. */
  readonly currentHttpRequests: number;
  readonly pendingInitializations: number;
  readonly highWatermark: number;
  readonly totalCapacityRejected: number;
  readonly totalInflightEvictionPrevented: number;
  readonly currentSession: HttpDiagnosticCurrentSession | null;
  /** Request-local view for a diagnostic call; never contains a routing id. */
  readonly currentRequest: HttpDiagnosticCurrentRequest | null;
  /** Process-local lifecycle ring tail (oldest-first, bounded by the HTTP layer). Additive. */
  readonly recentLifecycleEvents: ReadonlyArray<HttpLifecycleEvent>;
}

export interface CodexProDiagnosticContext {
  readonly generation: number;
  readonly fingerprint: string;
  readonly transportKind: DiagnosticTransportKind;
  readonly httpSessionMode?: "stateless" | "retained";
  readonly createdAt: number;
  readonly getHttpSnapshot?: () => HttpDiagnosticSnapshot;
}

export interface DiagnosticContextOptions {
  readonly transportKind: DiagnosticTransportKind;
  readonly httpSessionMode?: "stateless" | "retained";
  readonly getHttpSnapshot?: () => HttpDiagnosticSnapshot;
}

let nextDiagnosticGeneration = 0;

export function createDiagnosticContext(options: DiagnosticContextOptions): CodexProDiagnosticContext {
  const generation = ++nextDiagnosticGeneration;
  const fingerprint = randomBytes(24).toString("base64url");
  const context: CodexProDiagnosticContext = {
    generation,
    fingerprint,
    transportKind: options.transportKind,
    ...(options.httpSessionMode ? { httpSessionMode: options.httpSessionMode } : {}),
    createdAt: Date.now(),
    ...(options.getHttpSnapshot ? { getHttpSnapshot: options.getHttpSnapshot } : {})
  };
  return Object.freeze(context);
}
