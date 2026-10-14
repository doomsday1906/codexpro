import { constants as fsConstants } from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import type { CodexProConfig } from "./config.js";
import type { Workspace } from "./guard.js";
import { CodexProError, isSubpath, PathGuard } from "./guard.js";

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

async function openCanonicalArtifact(root: string, target: string): Promise<FileHandle> {
  if (!isSubpath(target, root)) throw new CodexProError("Artifact path escapes workspace root.");
  if (process.platform !== "linux") {
    const expected = await fsp.lstat(target);
    if (!expected.isFile() || await fsp.realpath(target) !== target) {
      throw new CodexProError("Artifact path changed before opening.");
    }
    const handle = await fsp.open(target, "r");
    try {
      const opened = await handle.stat();
      const current = await fsp.lstat(target);
      if (await fsp.realpath(target) !== target || current.isSymbolicLink() ||
          opened.dev !== expected.dev || opened.ino !== expected.ino ||
          opened.dev !== current.dev || opened.ino !== current.ino) {
        throw new CodexProError("Artifact path changed while opening.");
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  }
  const rootParts = path.relative(path.parse(root).root, root).split(path.sep).filter(Boolean);
  const targetParts = path.relative(root, target).split(path.sep).filter(Boolean);
  let directory = await fsp.open(path.parse(root).root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
  try {
    for (const part of [...rootParts, ...targetParts.slice(0, -1)]) {
      const next = await fsp.open(`/proc/self/fd/${directory.fd}/${part}`, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      await directory.close();
      directory = next;
    }
    return await fsp.open(`/proc/self/fd/${directory.fd}/${targetParts.at(-1) ?? "."}`, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } finally {
    await directory.close();
  }
}

/** Read at most `cap` bytes; exceeding the cap fails closed (source grew mid-read). */
async function readBoundedBytes(handle: FileHandle, cap: number): Promise<Buffer> {
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
}

export async function readWorkspaceArtifact(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  filePath: string,
  maxBytes?: number
): Promise<WorkspaceArtifact> {
  const resolved = guard.resolve(workspace, filePath);
  let handle: FileHandle;
  try {
    const canonical = guard.resolve(workspace, await fsp.realpath(resolved.absPath));
    handle = await openCanonicalArtifact(workspace.root, canonical.absPath);
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new CodexProError(`File not found: ${resolved.relPath}`);
    }
    throw error;
  }
  let buffer: Buffer;
  try {
    const preStat = await handle.stat();
    if (!preStat.isFile()) throw new CodexProError(`Not a file: ${resolved.relPath}`);
    const limit = Math.min(ARTIFACT_HARD_MAX_BYTES, maxBytes ?? Math.max(config.maxReadBytes, 1_000_000));
    if (preStat.size > limit) {
      throw new CodexProError(`Artifact is too large (${preStat.size} bytes). Limit: ${limit} bytes.`);
    }
    buffer = await readBoundedBytes(handle, preStat.size + 65_536);
    const postStat = await handle.stat();
    if (postStat.size !== preStat.size || postStat.mtimeMs !== preStat.mtimeMs || postStat.ctimeMs !== preStat.ctimeMs || buffer.byteLength !== postStat.size) {
      throw new CodexProError(`File changed during read: ${resolved.relPath}. Read the file again.`);
    }
  } finally {
    await handle.close();
  }
  return {
    path: resolved.relPath,
    mimeType: detectArtifactMimeType(buffer, resolved.relPath),
    bytes: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    data: buffer.toString("base64")
  };
}
