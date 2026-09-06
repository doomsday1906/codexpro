import { StringDecoder } from "node:string_decoder";
import { StreamingRedactor } from "./verificationOps.js";
import { PTY_LIMITS } from "./ptyValidator.js";
import { CodexProError } from "./guard.js";

/**
 * Internal states of the stateful terminal control sequence parser (LAW-009).
 */
export enum SanitizerState {
  GROUND = "GROUND",
  ESCAPE = "ESCAPE",
  ESC_INTERMEDIATE = "ESC_INTERMEDIATE",
  CSI_PARAM = "CSI_PARAM",
  CSI_INTERMEDIATE = "CSI_INTERMEDIATE",
  CSI_DISCARD = "CSI_DISCARD",
  OSC = "OSC",
  OSC_ESC = "OSC_ESC",
  OSC_DISCARD = "OSC_DISCARD",
  OSC_DISCARD_ESC = "OSC_DISCARD_ESC",
  STRING_CONTROL = "STRING_CONTROL",
  STRING_CONTROL_ESC = "STRING_CONTROL_ESC",
  STRING_CONTROL_DISCARD = "STRING_CONTROL_DISCARD",
  STRING_CONTROL_DISCARD_ESC = "STRING_CONTROL_DISCARD_ESC"
}

export interface TerminalSanitizerOptions {
  maxControlPayloadChars?: number;
}

/**
 * Stateful chunk-aware terminal control sanitizer and text normalizer (LAW-009).
 *
 * Requirements:
 * - Chunk-aware: handles split ESC/CSI/OSC/DCS/APC/PM/SOS sequences at any byte boundary.
 * - Stateful streaming UTF-8 decoding across multi-byte chunks.
 * - Memory-bounded: unterminated and overlong control strings never exceed maxControlPayloadChars.
 * - String-control terminators:
 *   - OSC: terminated by BEL (\x07), 7-bit ST (ESC \), or decoded 8-bit ST (U+009C).
 *   - DCS, APC, PM, SOS: terminated by ST only (ESC \ or U+009C). BEL does NOT terminate them.
 * - Fail-closed malformed control recovery: malformed ESC continuations inside OSC/DCS/APC/PM/SOS
 *   remain suppressed in control/discard states and never leak trailing payload to GROUND.
 * - Fail-closed CSI C0 handling: C0/DEL disturbance inside CSI parameters/intermediates is stripped
 *   without dropping to GROUND early, preventing final CSI control bytes from becoming visible text.
 * - Deterministic normalization: \r\n -> \n, standalone \r -> \n, \t preserved, \n preserved.
 * - All other C0 controls (NUL, BEL, BS, etc.) and DEL (0x7F) are stripped.
 * - Final output is safe printable Unicode text.
 */
export class TerminalSanitizer {
  public static readonly MAX_CONTROL_PAYLOAD_CHARS = 4096;

  private decoder = new StringDecoder("utf8");
  private state: SanitizerState = SanitizerState.GROUND;
  private pendingCr = false;
  private controlPayloadLength = 0;
  public readonly maxControlPayloadChars: number;

  constructor(options: TerminalSanitizerOptions = {}) {
    this.maxControlPayloadChars = options.maxControlPayloadChars ?? TerminalSanitizer.MAX_CONTROL_PAYLOAD_CHARS;
  }

  public push(chunk: Buffer | Uint8Array | string): string {
    const buf = typeof chunk === "string"
      ? Buffer.from(chunk, "utf8")
      : Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    const text = this.decoder.write(buf);
    if (!text) return "";
    return this.processDecodedString(text);
  }

  public finish(): string {
    const trailing = this.decoder.end();
    const out: string[] = [];
    if (trailing) {
      out.push(this.processDecodedString(trailing));
    }
    if (this.pendingCr) {
      out.push("\n");
      this.pendingCr = false;
    }
    // Fail-safe termination: unclosed control sequences at EOF are discarded
    this.state = SanitizerState.GROUND;
    this.controlPayloadLength = 0;
    return out.join("");
  }

  public reset(): void {
    this.decoder = new StringDecoder("utf8");
    this.state = SanitizerState.GROUND;
    this.pendingCr = false;
    this.controlPayloadLength = 0;
  }

  public getState(): SanitizerState {
    return this.state;
  }

  public getControlPayloadLength(): number {
    return this.controlPayloadLength;
  }

  public isPendingCr(): boolean {
    return this.pendingCr;
  }

  private processDecodedString(text: string): string {
    const out: string[] = [];

    for (const ch of text) {
      if (this.pendingCr) {
        this.pendingCr = false;
        if (ch !== "\n") {
          out.push("\n");
        }
      }

      switch (this.state) {
        case SanitizerState.GROUND: {
          if (ch === "\x1b") {
            this.state = SanitizerState.ESCAPE;
          } else if (ch === "\r") {
            this.pendingCr = true;
          } else if (ch === "\n") {
            out.push("\n");
          } else if (ch === "\t") {
            out.push("\t");
          } else if (ch.length === 1) {
            const code = ch.charCodeAt(0);
            if (code < 0x20 || code === 0x7f) {
              // Discard all other C0 controls (0x00..0x1F) and DEL (0x7F)
            } else if (code >= 0x80 && code <= 0x9f) {
              // Decoded UTF-8 C1 controls (U+0080..U+009F)
              if (code === 0x9b) {
                // CSI (0x9B)
                this.controlPayloadLength = 0;
                this.state = SanitizerState.CSI_PARAM;
              } else if (code === 0x9d) {
                // OSC (0x9D)
                this.controlPayloadLength = 0;
                this.state = SanitizerState.OSC;
              } else if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
                // DCS (0x90), SOS (0x98), PM (0x9E), APC (0x9F)
                this.controlPayloadLength = 0;
                this.state = SanitizerState.STRING_CONTROL;
              } else if (code === 0x85) {
                // NEL (0x85 Next Line) -> normalize to newline
                out.push("\n");
              } else {
                // Other C1 controls discarded
              }
            } else {
              // Safe printable character (ASCII >= 0x20 or Unicode > 0x9F)
              out.push(ch);
            }
          } else {
            // Multi-code-unit Unicode sequence (e.g. astral surrogate pair / emoji)
            out.push(ch);
          }
          break;
        }

        case SanitizerState.ESCAPE: {
          if (ch === "[") {
            this.controlPayloadLength = 0;
            this.state = SanitizerState.CSI_PARAM;
          } else if (ch === "]") {
            this.controlPayloadLength = 0;
            this.state = SanitizerState.OSC;
          } else if (ch === "P" || ch === "X" || ch === "^" || ch === "_") {
            // P = DCS, X = SOS, ^ = PM, _ = APC
            this.controlPayloadLength = 0;
            this.state = SanitizerState.STRING_CONTROL;
          } else if (ch >= " " && ch <= "/") {
            // 0x20..0x2F: Intermediate byte of escape sequence (e.g. ESC ( B)
            this.state = SanitizerState.ESC_INTERMEDIATE;
          } else if (ch >= "0" && ch <= "~") {
            // 0x30..0x7E: 2-character escape sequence (e.g. ESC c, ESC =, ESC >, ESC 7, ESC 8)
            // Completed; discarded without leaking control syntax
            this.state = SanitizerState.GROUND;
          } else if (ch === "\x1b") {
            // Consecutive ESC; abort prior escape and start new escape sequence
            this.state = SanitizerState.ESCAPE;
          } else {
            // Non-escape byte: abort escape sequence and return to GROUND
            this.state = SanitizerState.GROUND;
            if (ch === "\n") out.push("\n");
            else if (ch === "\r") this.pendingCr = true;
          }
          break;
        }

        case SanitizerState.ESC_INTERMEDIATE: {
          if (ch >= " " && ch <= "/") {
            this.state = SanitizerState.ESC_INTERMEDIATE;
          } else if (ch >= "0" && ch <= "~") {
            // Final byte terminates escape sequence; discarded
            this.state = SanitizerState.GROUND;
          } else if (ch === "\x1b") {
            this.state = SanitizerState.ESCAPE;
          } else if (ch.charCodeAt(0) < 0x20 || ch === "\x7f") {
            // C0/DEL disturbance inside intermediate bytes: strip and stay in ESC_INTERMEDIATE
          } else {
            this.state = SanitizerState.GROUND;
          }
          break;
        }

        case SanitizerState.CSI_PARAM: {
          if (ch >= "0" && ch <= "?") {
            // 0x30..0x3F: Parameter bytes (digits, semicolons, private flags)
            this.controlPayloadLength++;
            if (this.controlPayloadLength > this.maxControlPayloadChars) {
              this.state = SanitizerState.CSI_DISCARD;
            }
          } else if (ch >= " " && ch <= "/") {
            // 0x20..0x2F: Intermediate bytes
            this.controlPayloadLength++;
            if (this.controlPayloadLength > this.maxControlPayloadChars) {
              this.state = SanitizerState.CSI_DISCARD;
            } else {
              this.state = SanitizerState.CSI_INTERMEDIATE;
            }
          } else if (ch >= "@" && ch <= "~") {
            // 0x40..0x7E: Final byte terminates CSI sequence
            this.state = SanitizerState.GROUND;
          } else if (ch === "\x1b") {
            this.state = SanitizerState.ESCAPE;
          } else if (ch.charCodeAt(0) < 0x20 || ch === "\x7f") {
            // C0/DEL disturbance (e.g. BEL, NUL, BS) inside CSI:
            // Strip C0 byte and stay in CSI_PARAM to prevent early drop to GROUND
            // that would expose the final CSI byte as ordinary text.
            this.controlPayloadLength++;
            if (this.controlPayloadLength > this.maxControlPayloadChars) {
              this.state = SanitizerState.CSI_DISCARD;
            }
          } else {
            // Out-of-range unexpected character: move to CSI_DISCARD to suppress until final byte
            this.controlPayloadLength++;
            this.state = SanitizerState.CSI_DISCARD;
          }
          break;
        }

        case SanitizerState.CSI_INTERMEDIATE: {
          if (ch >= " " && ch <= "/") {
            this.controlPayloadLength++;
            if (this.controlPayloadLength > this.maxControlPayloadChars) {
              this.state = SanitizerState.CSI_DISCARD;
            }
          } else if (ch >= "@" && ch <= "~") {
            this.state = SanitizerState.GROUND;
          } else if (ch === "\x1b") {
            this.state = SanitizerState.ESCAPE;
          } else if (ch.charCodeAt(0) < 0x20 || ch === "\x7f") {
            // C0 disturbance inside intermediate bytes: strip and stay
            this.controlPayloadLength++;
            if (this.controlPayloadLength > this.maxControlPayloadChars) {
              this.state = SanitizerState.CSI_DISCARD;
            }
          } else {
            this.controlPayloadLength++;
            this.state = SanitizerState.CSI_DISCARD;
          }
          break;
        }

        case SanitizerState.CSI_DISCARD: {
          // Bounded overflow state: discard parameters until final byte terminates
          if (ch >= "@" && ch <= "~") {
            this.state = SanitizerState.GROUND;
          } else if (ch === "\x1b") {
            this.state = SanitizerState.ESCAPE;
          }
          break;
        }

        case SanitizerState.OSC: {
          if (ch === "\x07" || ch === "\u009c") {
            // BEL (\x07) or decoded 8-bit ST (\u009C) terminates OSC
            this.state = SanitizerState.GROUND;
          } else if (ch === "\x1b") {
            this.state = SanitizerState.OSC_ESC;
          } else {
            this.controlPayloadLength += ch.length;
            if (this.controlPayloadLength > this.maxControlPayloadChars) {
              this.state = SanitizerState.OSC_DISCARD;
            }
          }
          break;
        }

        case SanitizerState.OSC_ESC: {
          if (ch === "\\" || ch === "\u009c") {
            // 7-bit ST (ESC \) or 8-bit ST terminates OSC
            this.state = SanitizerState.GROUND;
          } else if (ch === "\x07") {
            // BEL terminates OSC
            this.state = SanitizerState.GROUND;
          } else if (ch === "\x1b") {
            // Another ESC: stay in OSC_ESC
            this.state = SanitizerState.OSC_ESC;
          } else {
            // Malformed ESC continuation: fail closed by remaining inside suppressed OSC payload.
            // Do NOT return to GROUND early.
            this.controlPayloadLength += ch.length + 1;
            if (this.controlPayloadLength > this.maxControlPayloadChars) {
              this.state = SanitizerState.OSC_DISCARD;
            } else {
              this.state = SanitizerState.OSC;
            }
          }
          break;
        }

        case SanitizerState.OSC_DISCARD: {
          // Bounded overflow state: discard OSC payload until terminator
          if (ch === "\x07" || ch === "\u009c") {
            this.state = SanitizerState.GROUND;
          } else if (ch === "\x1b") {
            this.state = SanitizerState.OSC_DISCARD_ESC;
          }
          break;
        }

        case SanitizerState.OSC_DISCARD_ESC: {
          if (ch === "\\" || ch === "\u009c") {
            this.state = SanitizerState.GROUND;
          } else if (ch === "\x07") {
            this.state = SanitizerState.GROUND;
          } else if (ch === "\x1b") {
            this.state = SanitizerState.OSC_DISCARD_ESC;
          } else {
            // Malformed continuation: stay in discard state
            this.state = SanitizerState.OSC_DISCARD;
          }
          break;
        }

        case SanitizerState.STRING_CONTROL: {
          // DCS (ESC P), SOS (ESC X), PM (ESC ^), APC (ESC _)
          // Terminated by ST ONLY (8-bit U+009C or 7-bit ESC \). BEL does NOT terminate!
          if (ch === "\u009c") {
            this.state = SanitizerState.GROUND;
          } else if (ch === "\x1b") {
            this.state = SanitizerState.STRING_CONTROL_ESC;
          } else {
            // BEL (\x07) and arbitrary bytes remain suppressed as active string control payload
            this.controlPayloadLength += ch.length;
            if (this.controlPayloadLength > this.maxControlPayloadChars) {
              this.state = SanitizerState.STRING_CONTROL_DISCARD;
            }
          }
          break;
        }

        case SanitizerState.STRING_CONTROL_ESC: {
          if (ch === "\\" || ch === "\u009c") {
            // 7-bit ST (ESC \) or 8-bit ST terminates string control
            this.state = SanitizerState.GROUND;
          } else if (ch === "\x1b") {
            this.state = SanitizerState.STRING_CONTROL_ESC;
          } else {
            // Malformed ESC continuation: fail closed by remaining inside suppressed string control payload.
            // Do NOT return to GROUND early.
            this.controlPayloadLength += ch.length + 1;
            if (this.controlPayloadLength > this.maxControlPayloadChars) {
              this.state = SanitizerState.STRING_CONTROL_DISCARD;
            } else {
              this.state = SanitizerState.STRING_CONTROL;
            }
          }
          break;
        }

        case SanitizerState.STRING_CONTROL_DISCARD: {
          // Bounded overflow state: discard string control payload until ST only
          if (ch === "\u009c") {
            this.state = SanitizerState.GROUND;
          } else if (ch === "\x1b") {
            this.state = SanitizerState.STRING_CONTROL_DISCARD_ESC;
          }
          break;
        }

        case SanitizerState.STRING_CONTROL_DISCARD_ESC: {
          if (ch === "\\" || ch === "\u009c") {
            this.state = SanitizerState.GROUND;
          } else if (ch === "\x1b") {
            this.state = SanitizerState.STRING_CONTROL_DISCARD_ESC;
          } else {
            this.state = SanitizerState.STRING_CONTROL_DISCARD;
          }
          break;
        }
      }
    }

    return out.join("");
  }
}

/**
 * Safely calculates the byte length of the longest UTF-8 prefix of `buffer`
 * that does not exceed `limit` and does not split a multi-byte code point.
 */
export function utf8PrefixLength(buffer: Buffer, limit: number): number {
  const requested = Math.min(Math.max(0, limit), buffer.byteLength);
  if (requested === buffer.byteLength) return requested;
  let end = requested;
  while (end > 0) {
    const byte = buffer[end - 1];
    if ((byte & 0x80) === 0) return requested; // ASCII byte
    if ((byte & 0xc0) === 0x80) {
      // Continuation byte: scan backwards
      end -= 1;
      continue;
    }
    // Lead byte found
    const needed = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : 2;
    return requested - (end - 1) >= needed ? requested : end - 1;
  }
  return 0;
}

/**
 * Streaming collector that bounds retained output bytes without unbounded memory retention.
 * Enforces UTF-8 boundary integrity during truncation so no partial code points are returned.
 */
export class BoundedTranscriptCollector {
  private chunks: Buffer[] = [];
  private retainedBytes = 0;
  private truncated = false;
  public readonly maxBytes: number;

  constructor(maxBytes: number) {
    if (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new CodexProError("maxBytes must be a positive finite number.");
    }
    this.maxBytes = Math.floor(maxBytes);
  }

  public append(chunk: Buffer): void {
    if (chunk.byteLength === 0) return;
    if (this.truncated) return;
    const remaining = this.maxBytes - this.retainedBytes;
    if (remaining <= 0) {
      this.truncated = true;
      return;
    }
    if (chunk.byteLength <= remaining) {
      this.chunks.push(chunk);
      this.retainedBytes += chunk.byteLength;
    } else {
      const safePrefixLen = utf8PrefixLength(chunk, remaining);
      if (safePrefixLen > 0) {
        this.chunks.push(chunk.subarray(0, safePrefixLen));
        this.retainedBytes += safePrefixLen;
      }
      this.truncated = true;
    }
  }

  public getText(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }

  public getByteLength(): number {
    return this.retainedBytes;
  }

  public isTruncated(): boolean {
    return this.truncated;
  }
}

export interface PtyPipelineOptions {
  /** Mandatory active server output authority (config.maxOutputBytes); no silent default allowed */
  maxOutputBytes: number;
  hardOutputCeilingBytes?: number;
  maxControlPayloadChars?: number;
}

export interface PtyPipelineResult {
  transcript: string;
  rawObservedBytes: number;
  sanitizedBytes: number;
  retainedBytes: number;
  truncated: boolean;
  ceilingExceeded: boolean;
}

/**
 * Complete terminal-output security pipeline (LAW-009, LAW-010, LAW-014).
 *
 * Required conceptual order:
 * raw PTY bytes
 *   -> bounded streaming UTF-8 decode
 *   -> stateful terminal-control sanitizer / normalizer
 *   -> accepted M009 StreamingRedactor / private-key / credential redaction
 *   -> bounded retained text
 */
export class PtyTranscriptPipeline {
  private readonly sanitizer: TerminalSanitizer;
  private readonly redactor: StreamingRedactor;
  private readonly collector: BoundedTranscriptCollector;
  public readonly maxOutputBytes: number;
  public readonly hardOutputCeilingBytes: number;
  private rawObservedBytes = 0;
  private sanitizedBytes = 0;
  private ceilingExceeded = false;

  constructor(options: PtyPipelineOptions) {
    if (
      !options ||
      typeof options !== "object" ||
      options.maxOutputBytes === undefined ||
      options.maxOutputBytes === null ||
      typeof options.maxOutputBytes !== "number" ||
      !Number.isFinite(options.maxOutputBytes) ||
      options.maxOutputBytes <= 0
    ) {
      throw new CodexProError("maxOutputBytes is mandatory and must be a positive finite number.");
    }
    this.maxOutputBytes = Math.floor(options.maxOutputBytes);
    this.hardOutputCeilingBytes = options.hardOutputCeilingBytes ?? PTY_LIMITS.hardOutputCeilingBytes;
    this.sanitizer = new TerminalSanitizer({ maxControlPayloadChars: options.maxControlPayloadChars });
    this.redactor = new StreamingRedactor();
    this.collector = new BoundedTranscriptCollector(this.maxOutputBytes);
  }

  public push(chunk: Buffer | Uint8Array | string): string {
    const rawBuf = typeof chunk === "string"
      ? Buffer.from(chunk, "utf8")
      : Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);

    this.rawObservedBytes += rawBuf.byteLength;
    if (this.rawObservedBytes > this.hardOutputCeilingBytes) {
      this.ceilingExceeded = true;
    }

    // Step 1: Terminal control sanitization & normalization BEFORE redaction (LAW-009, LAW-010)
    const sanitizedText = this.sanitizer.push(rawBuf);
    if (!sanitizedText) return "";

    const sanitizedBuf = Buffer.from(sanitizedText, "utf8");
    this.sanitizedBytes += sanitizedBuf.byteLength;

    // Step 2: M009 StreamingRedactor (private key scanner + diagnostic secret redaction)
    const redactedChunks = this.redactor.push(sanitizedBuf);
    for (const rChunk of redactedChunks) {
      this.collector.append(rChunk);
    }

    return Buffer.concat(redactedChunks).toString("utf8");
  }

  public peekPendingText(): string {
    return this.redactor.peekPending();
  }

  public finish(): PtyPipelineResult {
    // Step 1: Finalize sanitizer (flushes pending incomplete UTF-8 / pending \r)
    const finalSanitized = this.sanitizer.finish();
    if (finalSanitized) {
      const finalBuf = Buffer.from(finalSanitized, "utf8");
      this.sanitizedBytes += finalBuf.byteLength;
      const redactedChunks = this.redactor.push(finalBuf);
      for (const rChunk of redactedChunks) {
        this.collector.append(rChunk);
      }
    }

    // Step 2: Finalize redactor (flushes pending lines and private key blocks)
    const flushChunks = this.redactor.flush();
    for (const fChunk of flushChunks) {
      this.collector.append(fChunk);
    }

    const transcript = this.collector.getText();
    // LAW-014: truncated truthfully includes response-tail truncation and fail-closed sanitizer/redactor suppression
    const truncated = this.collector.isTruncated() || this.redactor.hasSuppressedContent;

    return {
      transcript,
      rawObservedBytes: this.rawObservedBytes,
      sanitizedBytes: this.sanitizedBytes,
      retainedBytes: Buffer.byteLength(transcript, "utf8"),
      truncated,
      ceilingExceeded: this.ceilingExceeded
    };
  }

  public getRawObservedBytes(): number {
    return this.rawObservedBytes;
  }

  public getSanitizedBytes(): number {
    return this.sanitizedBytes;
  }

  public isCeilingExceeded(): boolean {
    return this.ceilingExceeded;
  }

  public getRedactor(): StreamingRedactor {
    return this.redactor;
  }

  public getSanitizer(): TerminalSanitizer {
    return this.sanitizer;
  }

  public getCollector(): BoundedTranscriptCollector {
    return this.collector;
  }
}

/**
 * Convenience helper for one-shot terminal string sanitization.
 */
export function sanitizeTerminalText(input: Buffer | Uint8Array | string): string {
  const sanitizer = new TerminalSanitizer();
  const res1 = sanitizer.push(input);
  const res2 = sanitizer.finish();
  return res1 + res2;
}

/**
 * Convenience helper for one-shot terminal output pipeline (sanitizer + redaction + output bounding).
 * Requires explicit active maxOutputBytes authority.
 */
export function sanitizeAndRedactTerminalOutput(
  input: Buffer | Uint8Array | string,
  options: PtyPipelineOptions
): PtyPipelineResult {
  const pipeline = new PtyTranscriptPipeline(options);
  pipeline.push(input);
  return pipeline.finish();
}
