import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, PathGuard } from "./guard.js";

export interface WorkspaceArtifact {
  path: string;
  mimeType: string;
  bytes: number;
  sha256: string;
  data: string;
}

/** Absolute hard ceiling for one artifact read. Per-call max_bytes is clamped to this. */
export const ARTIFACT_HARD_MAX_BYTES = 10_000_000;
/** Smallest admittable per-call max_bytes, mirroring the view_image floor. */
export const ARTIFACT_MIN_MAX_BYTES = 4_096;

function hasBytes(buffer: Buffer, offset: number, expected: readonly number[]): boolean {
  if (offset < 0 || offset + expected.length > buffer.length) return false;
  return expected.every((byte, index) => buffer[offset + index] === byte);
}

function asciiAt(buffer: Buffer, offset: number, length: number): string | null {
  if (offset < 0 || offset + length > buffer.length) return null;
  return buffer.subarray(offset, offset + length).toString("ascii");
}

/**
 * Authoritative magic-byte sniff. Returns null when the content matches no
 * known signature; the caller then falls back to the extension hint and
 * finally to application/octet-stream. The caller never supplies a MIME type.
 */
export function sniffArtifactMimeType(buffer: Buffer): string | null {
  if (buffer.length >= 8 && hasBytes(buffer, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6) {
    const header = asciiAt(buffer, 0, 6);
    if (header === "GIF87a" || header === "GIF89a") return "image/gif";
  }
  if (buffer.length >= 12 && asciiAt(buffer, 0, 4) === "RIFF" && asciiAt(buffer, 8, 4) === "WEBP") return "image/webp";
  if (buffer.length >= 5 && asciiAt(buffer, 0, 5) === "%PDF-") return "application/pdf";
  if (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    (buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
    buffer[3] === 0x04
  ) {
    return "application/zip";
  }
  if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return "application/gzip";
  // ISO base-media / MP4 family: size (4 bytes) + "ftyp" + major brand (4 bytes).
  if (buffer.length >= 12 && asciiAt(buffer, 4, 4) === "ftyp") {
    const brand = asciiAt(buffer, 8, 4) ?? "";
    if (brand.trim() === "qt") return "video/quicktime";
    if (brand === "M4A" || brand === "m4a") return "audio/mp4";
    return "video/mp4";
  }
  if (buffer.length >= 12 && asciiAt(buffer, 0, 4) === "RIFF" && asciiAt(buffer, 8, 4) === "WAVE") return "audio/wav";
  if (buffer.length >= 12 && asciiAt(buffer, 0, 4) === "RIFF" && asciiAt(buffer, 8, 4) === "AVI") return "video/x-msvideo";
  if (buffer.length >= 4 && asciiAt(buffer, 0, 4) === "OggS") return "audio/ogg";
  if (buffer.length >= 4 && asciiAt(buffer, 0, 3) === "ID3") return "audio/mpeg";
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (buffer.length >= 4 && asciiAt(buffer, 0, 4) === "fLaC") return "audio/flac";
  if (buffer.length >= 4 && hasBytes(buffer, 0, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (buffer.length >= 3 && asciiAt(buffer, 0, 3) === "FLV") return "video/x-flv";
  return null;
}

const EXTENSION_MIME_HINTS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".m4v": "video/x-m4v",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".ogv": "video/ogg",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".flac": "audio/flac",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".json": "application/json",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".html": "text/html"
};

/**
 * Derive the served MIME type: magic bytes win; a known file extension is
 * only a hint when the content is unrecognized; otherwise a neutral fallback.
 * The caller cannot inject a MIME type.
 */
export function detectArtifactMimeType(buffer: Buffer, relPath: string): string {
  const sniffed = sniffArtifactMimeType(buffer);
  if (sniffed) return sniffed;
  const hint = EXTENSION_MIME_HINTS[path.extname(relPath).toLowerCase()];
  if (hint) return hint;
  return "application/octet-stream";
}

/** Read at most `cap` bytes; exceeding the cap fails closed (source grew mid-read). */
async function readBoundedBytes(absPath: string, cap: number): Promise<Buffer> {
  const handle = await fsp.open(absPath, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const slab = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await handle.read(slab, 0, slab.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > cap) {
        throw new CodexProError("File grew during read. Read the file again.");
      }
      chunks.push(Buffer.from(slab.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readWorkspaceArtifact(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  maxBytes?: number
): Promise<WorkspaceArtifact> {
  const resolved = guard.resolve(workspace, filePath);
  let preStat;
  try {
    preStat = await fsp.stat(resolved.absPath);
  } catch {
    throw new CodexProError(`File not found: ${resolved.relPath}`);
  }
  if (!preStat.isFile()) throw new CodexProError(`Not a file: ${resolved.relPath}`);
  const limit = Math.min(ARTIFACT_HARD_MAX_BYTES, maxBytes ?? Math.max(config.maxReadBytes, 1_000_000));
  if (preStat.size > limit) {
    throw new CodexProError(`Artifact is too large (${preStat.size} bytes). Limit: ${limit} bytes.`);
  }
  const buffer = await readBoundedBytes(resolved.absPath, preStat.size + 65_536);
  const postStat = await fsp.stat(resolved.absPath);
  if (postStat.size !== preStat.size || postStat.mtimeMs !== preStat.mtimeMs || postStat.ctimeMs !== preStat.ctimeMs) {
    throw new CodexProError(`File changed during read: ${resolved.relPath}. Read the file again.`);
  }
  if (buffer.byteLength !== postStat.size) {
    throw new CodexProError(`File changed during read: ${resolved.relPath}. Read the file again.`);
  }
  return {
    path: resolved.relPath,
    mimeType: detectArtifactMimeType(buffer, resolved.relPath),
    bytes: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    data: buffer.toString("base64")
  };
}
