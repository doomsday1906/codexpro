import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { centralArtifactsDirForRun, type DelegationRunRecord } from "./delegationStore.js";

/** Shared helpers are engine/project resources, including on --standalone.
 * The qualified engine exposes no atomic project exclusion + helper disposal
 * contract. Neither an empty session-list snapshot nor /proc attribution
 * grants that ownership. This module NEVER deletes sessions, signals helpers,
 * or authorizes workdir deletion. Explicit run retirement only seals future
 * adapter follow-ups and preserves an engine export in central storage.
 */
export const OPENCODE_CLOSEOUT_BLOCKER = "OpenCode v2.0.22 exposes location eviction and MCP disconnect, but no documented atomic project exclusion plus shared-helper disposal contract. Eviction permits immediate reinitialization; disconnect removes tools for concurrent users. CLI session delete does not dispose per-project helpers, including on --standalone. Session, shared helpers and workdir are retained; workdir retirement requires the engine/project lifecycle owner.";
const INTENT = "retirement.json";
const EXPORT = "session-export.json";
const CONFIRMATION = "archive-confirmed.json";
const MAX_EXPORT = 8 * 1024 * 1024;

function artifactDir(bridgeDir: string, run: DelegationRunRecord): string {
  const dir = centralArtifactsDirForRun(bridgeDir, run.runId);
  if (fs.realpathSync(dir) !== path.resolve(dir)) throw new Error("closeout storage is redirected");
  return dir;
}

function dirFor(bridgeDir: string, run: DelegationRunRecord): string {
  const dir = centralArtifactsDirForRun(bridgeDir, run.runId);
  // Inspect existing ancestors BEFORE mkdir so a redirected parent cannot
  // cause even preparatory writes outside this run's central storage.
  let ancestor = dir;
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error("closeout storage unavailable");
    ancestor = parent;
  }
  if (fs.realpathSync(ancestor) !== path.resolve(ancestor)) throw new Error("closeout storage is redirected");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return artifactDir(bridgeDir, run);
}

function readFile(file: string): string {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_EXPORT * 2 + 8192) throw new Error("invalid closeout artifact");
    const bytes = Buffer.alloc(stat.size + 1);
    const n = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (n !== stat.size) throw new Error("closeout artifact changed");
    return bytes.subarray(0, n).toString("utf8");
  } finally { fs.closeSync(fd); }
}

function syncDir(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Publish complete bytes without overwriting anyone's artifact. The atomic
 * link arbitrates concurrent retries; finally removes only our unique stage.
 * An interrupted process can leave a stage but never a partial final file.
 */
function publish(file: string, text: string): void {
  const dir = path.dirname(file);
  const stage = path.join(dir, `.closeout-${randomUUID()}.tmp`);
  let fd: number | undefined;
  let created = false;
  try {
    fd = fs.openSync(stage, "wx", 0o600); created = true;
    fs.writeFileSync(fd, text, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    try { fs.linkSync(stage, file); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    syncDir(dir);
    // Content equality also fails closed for preoccupied or conflicting data.
    if (readFile(file) !== text) throw new Error("closeout artifact conflict");
  } finally {
    try { if (fd !== undefined) fs.closeSync(fd); }
    finally { if (created) fs.unlinkSync(stage); }
  }
}

function intentFor(run: DelegationRunRecord): string {
  return JSON.stringify({ runId: run.runId, ownerIdHash: run.ownerIdHash,
    ownerKind: run.ownerKind, workdir: run.workdir, engine: run.engine,
    sessionId: run.session?.sessionId ?? null }) + "\n";
}

/** Presence is the monotonic no-followup gate, even if unreadable/corrupt.
 * A persisted run snapshot cannot erase this independently published intent.
 */
export function hasCloseoutIntent(bridgeDir: string, run: DelegationRunRecord): boolean {
  try { fs.lstatSync(path.join(centralArtifactsDirForRun(bridgeDir, run.runId), INTENT)); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
}

export function verifyCloseoutIntent(bridgeDir: string, run: DelegationRunRecord): void {
  if (readFile(path.join(artifactDir(bridgeDir, run), INTENT)) !== intentFor(run)) throw new Error("closeout intent identity conflict");
}

function validateExport(text: string, sessionId: string): void {
  const data = JSON.parse(text);
  // The supported export envelope carries info.id; older CLI output uses id.
  if (!data || typeof data !== "object" || Array.isArray(data) ||
      (data.info?.id ?? data.id) !== sessionId) throw new Error("session export identity mismatch");
}

/** One atomically published envelope binds provenance and the exact engine
 * output in the same durability boundary; a preoccupied raw export or a
 * different run's archive cannot be adopted as this run's preservation.
 */
function archiveBytes(run: DelegationRunRecord, output: string): string {
  return JSON.stringify({ version: 1, binding: JSON.parse(intentFor(run)), output }) + "\n";
}

function outputFromArchive(run: DelegationRunRecord, text: string): string {
  const archive = JSON.parse(text);
  if (archive?.version !== 1 || JSON.stringify(archive.binding) + "\n" !== intentFor(run) ||
      typeof archive.output !== "string" || Buffer.byteLength(archive.output) > MAX_EXPORT) {
    throw new Error("closeout export provenance mismatch");
  }
  validateExport(archive.output, run.session?.sessionId ?? "");
  return archive.output;
}

function confirmationFor(run: DelegationRunRecord, bytes: string): string {
  return JSON.stringify({ binding: JSON.parse(intentFor(run)),
    sha256: createHash("sha256").update(bytes, "utf8").digest("hex") }) + "\n";
}

/** Written only AFTER the export and its directory are synced. Its presence
 * binds that completed durability step to these exact bytes. No mutable run
 * snapshot is rewritten, so a concurrent adapter turn cannot be overwritten.
 */
function confirmArchive(dir: string, run: DelegationRunRecord, expected?: string): void {
  const bytes = readFile(path.join(dir, EXPORT));
  if (expected !== undefined && bytes !== expected) throw new Error("archive changed before confirmation");
  outputFromArchive(run, bytes);
  const fd = fs.openSync(path.join(dir, EXPORT), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDir(dir);
  publish(path.join(dir, CONFIRMATION), confirmationFor(run, bytes));
}

export interface SessionCloseoutResult {
  retired: boolean;
  exported: boolean;
  export_bytes?: number;
  reason: string;
  engine_exit_code?: number | null;
  engine_signal?: string | null;
  engine_error?: string;
  dir_clear: false;
  cleanup_finished: false;
  session_deleted: false;
  helpers_signalled: number[];
  workdir_release: "blocked";
  blocker: string;
}

export function closeoutReceipt(bridgeDir: string, run: DelegationRunRecord): SessionCloseoutResult {
  let exported = false;
  let exportBytes: number | undefined;
  let reason = "not-retired";
  const retired = hasCloseoutIntent(bridgeDir, run);
  if (retired) {
    reason = "export-pending";
    try {
      verifyCloseoutIntent(bridgeDir, run);
      const dir = artifactDir(bridgeDir, run);
      const bytes = readFile(path.join(dir, EXPORT));
      const output = outputFromArchive(run, bytes);
      let confirmed: string | undefined;
      try { confirmed = readFile(path.join(dir, CONFIRMATION)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (confirmed !== undefined && confirmed !== confirmationFor(run, bytes)) throw new Error("archive confirmation conflict");
      exported = confirmed !== undefined;
      if (exported) exportBytes = Buffer.byteLength(output);
      reason = exported ? "archived-release-blocked" : "archive-present-unconfirmed";
    } catch (error) {
      reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "export-pending" : "closeout-artifact-unverified";
    }
  }
  return { retired, exported, ...(exportBytes !== undefined ? { export_bytes: exportBytes } : {}),
    reason, dir_clear: false, cleanup_finished: false, session_deleted: false,
    helpers_signalled: [], workdir_release: "blocked", blocker: OPENCODE_CLOSEOUT_BLOCKER };
}

/** Called only by the owner-authorized explicit public closeout handler after
 * trusted run-state and live-attempt checks. Never accepts caller state/PIDs.
 */
export function archiveRetiredSession(bridgeDir: string, run: DelegationRunRecord, bin: string, timeoutMs: number): SessionCloseoutResult {
  let result = closeoutReceipt(bridgeDir, run);
  try {
    const dir = dirFor(bridgeDir, run);
    publish(path.join(dir, INTENT), intentFor(run));
    verifyCloseoutIntent(bridgeDir, run);
    result = closeoutReceipt(bridgeDir, run);
    if (result.exported || result.reason === "archive-present-unconfirmed") {
      // Reconciliation of an interruption after atomic publication but before
      // the run confirmation: revalidate AND fsync, never trust file presence.
      confirmArchive(dir, run);
      return closeoutReceipt(bridgeDir, run);
    }
    // A corrupt existing archive cannot be overwritten by a retry.
    if (result.reason === "closeout-artifact-unverified") return result;
    if (!run.session?.sessionId) return { ...result, reason: "session-identity-unavailable" };
    // Server-backed sessions live in the run's private DB. Although CLI
    // export supports --server, this closeout route does not revive the
    // terminal run's disposed private server or export from the shared DB.
    if (run.opencodeRoute === "steerable-server") return { ...result, reason: "private-server-export-unsupported" };
    const call = spawnSync(bin, ["session", "export", run.session.sessionId], {
      cwd: run.workdir, timeout: timeoutMs, killSignal: "SIGKILL", encoding: "utf8", maxBuffer: MAX_EXPORT,
      env: { ...process.env, NO_COLOR: "1" }, windowsHide: true
    });
    const exit = { engine_exit_code: call.status, engine_signal: call.signal,
      ...(call.error ? { engine_error: (call.error as NodeJS.ErrnoException).code ?? "spawn-error" } : {}) };
    if (call.status !== 0 || call.error || call.signal) return { ...result, ...exit, reason: "export-failed" };
    const text = String(call.stdout ?? "");
    try { validateExport(text, run.session.sessionId); }
    catch { return { ...result, ...exit, reason: "export-invalid" }; }
    const bytes = archiveBytes(run, text);
    publish(path.join(dir, EXPORT), bytes);
    confirmArchive(dir, run, bytes);
    // The final scan is controlling, not advisory: a failed read/identity or
    // confirmation check cannot be overridden into exported=true.
    return { ...closeoutReceipt(bridgeDir, run), ...exit };
  } catch { return { ...closeoutReceipt(bridgeDir, run), exported: false, reason: "persist-or-verify-failed" }; }
}

export function readCloseoutExport(bridgeDir: string, run: DelegationRunRecord, offset: number, maxChars: number): Record<string, unknown> {
  verifyCloseoutIntent(bridgeDir, run);
  const dir = artifactDir(bridgeDir, run);
  const bytes = readFile(path.join(dir, EXPORT));
  // The confirmation must bind the exact snapshot being paged. An earlier
  // receipt scan cannot verify bytes reopened after a concurrent mutation.
  if (readFile(path.join(dir, CONFIRMATION)) !== confirmationFor(run, bytes)) throw new Error("archive not confirmed");
  const text = outputFromArchive(run, bytes);
  const end = Math.min(offset + maxChars, text.length);
  return { run_id: run.runId, offset, total_chars: text.length,
    text: text.slice(offset, end), next_offset: end < text.length ? end : null };
}
