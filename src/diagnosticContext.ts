import { randomBytes } from "node:crypto";

export type DiagnosticTransportKind = "http" | "stdio" | "in-memory";

export interface HttpDiagnosticCurrentSession {
  readonly createdAt: number;
  readonly lastSeenAt: number;
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
  readonly pendingInitializations: number;
  readonly highWatermark: number;
  readonly totalCapacityRejected: number;
  readonly totalInflightEvictionPrevented: number;
  readonly currentSession: HttpDiagnosticCurrentSession | null;
  /** Process-local lifecycle ring tail (oldest-first, bounded by the HTTP layer). Additive. */
  readonly recentLifecycleEvents: ReadonlyArray<HttpLifecycleEvent>;
}

export interface CodexProDiagnosticContext {
  readonly generation: number;
  readonly fingerprint: string;
  readonly transportKind: DiagnosticTransportKind;
  readonly createdAt: number;
  readonly getHttpSnapshot?: () => HttpDiagnosticSnapshot;
}

export interface DiagnosticContextOptions {
  readonly transportKind: DiagnosticTransportKind;
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
    createdAt: Date.now(),
    ...(options.getHttpSnapshot ? { getHttpSnapshot: options.getHttpSnapshot } : {})
  };
  return Object.freeze(context);
}
