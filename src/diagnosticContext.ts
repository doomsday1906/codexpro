import { randomBytes } from "node:crypto";

export type DiagnosticTransportKind = "http" | "stdio" | "in-memory";

export interface HttpDiagnosticCurrentSession {
  readonly createdAt: number;
  readonly lastSeenAt: number;
}

export interface HttpDiagnosticSnapshot {
  readonly active: number;
  readonly max: number;
  readonly ttlMs: number;
  readonly totalInitialized: number;
  readonly totalClosed: number;
  readonly totalExpired: number;
  readonly totalCapacityEvicted: number;
  readonly currentSession: HttpDiagnosticCurrentSession | null;
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
