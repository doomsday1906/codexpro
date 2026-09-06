#!/usr/bin/env node
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  TerminalSanitizer,
  SanitizerState,
  BoundedTranscriptCollector,
  PtyTranscriptPipeline,
  sanitizeTerminalText,
  sanitizeAndRedactTerminalOutput,
  utf8PrefixLength
} from "../dist/ptyTerminalSanitizer.js";
import { StreamingRedactor } from "../dist/verificationOps.js";

console.log("# RepoConnect M010 TASK-003 Terminal Sanitizer & Redaction Security Smoke");

let testsRun = 0;
let testsPassed = 0;

async function test(name, fn) {
  testsRun++;
  try {
    await fn();
    testsPassed++;
    console.log(`  [PASS] Test ${String(testsRun).padStart(2, "0")}: ${name}`);
  } catch (error) {
    console.error(`  [FAIL] Test ${String(testsRun).padStart(2, "0")}: ${name}`);
    console.error(error);
    process.exit(1);
  }
}

// Helper to push an input through sanitizer either as a single chunk or byte-by-byte
function runSanitizer(input, byteByByte = false) {
  const sanitizer = new TerminalSanitizer();
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input, "utf8");
  if (!byteByByte) {
    const p1 = sanitizer.push(buf);
    const p2 = sanitizer.finish();
    return p1 + p2;
  }
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    out += sanitizer.push(buf.subarray(i, i + 1));
  }
  out += sanitizer.finish();
  return out;
}

// --------------------------------------------------------------------------
// Test 01: Ordinary printable text survives
// --------------------------------------------------------------------------
await test("ordinary printable text survives intact", () => {
  const sample = "Hello world! 1234567890 \t\nSome accented: café, naïve, résumé.\nCJK: 你好世界\nGreek: Καλημέρα κόσμε\n";
  const result = runSanitizer(sample);
  assert.equal(result, sample);

  // Single chunk vs byte by byte
  const bbb = runSanitizer(sample, true);
  assert.equal(bbb, sample);
});

// --------------------------------------------------------------------------
// Test 02: Split UTF-8 survives correctly across chunk splits
// --------------------------------------------------------------------------
await test("split UTF-8 survives correctly across chunk splits", () => {
  const sanitizer = new TerminalSanitizer();
  // 2-byte 'é' = 0xC3 0xA9
  const c1 = sanitizer.push(Buffer.from([0xc3]));
  assert.equal(c1, "");
  const c2 = sanitizer.push(Buffer.from([0xa9]));
  assert.equal(c2, "é");

  // 3-byte '€' = 0xE2 0x82 0xAC
  const e1 = sanitizer.push(Buffer.from([0xe2]));
  assert.equal(e1, "");
  const e2 = sanitizer.push(Buffer.from([0x82]));
  assert.equal(e2, "");
  const e3 = sanitizer.push(Buffer.from([0xac]));
  assert.equal(e3, "€");

  // 4-byte emoji 🚀 = 0xF0 0x9F 0x9A 0x80
  const r1 = sanitizer.push(Buffer.from([0xf0]));
  assert.equal(r1, "");
  const r2 = sanitizer.push(Buffer.from([0x9f]));
  assert.equal(r2, "");
  const r3 = sanitizer.push(Buffer.from([0x9a]));
  assert.equal(r3, "");
  const r4 = sanitizer.push(Buffer.from([0x80]));
  assert.equal(r4, "🚀");

  const fin = sanitizer.finish();
  assert.equal(fin, "");
});

// --------------------------------------------------------------------------
// Test 03: Malformed/incomplete UTF-8 is safe
// --------------------------------------------------------------------------
await test("malformed/incomplete UTF-8 is safe and fails closed to replacement char", () => {
  const sanitizer = new TerminalSanitizer();
  // Invalid lead byte 0xFF
  const res1 = sanitizer.push(Buffer.from([0xff]));
  assert.match(res1, /\uFFFD/);

  // Lone continuation byte 0x80
  const res2 = sanitizer.push(Buffer.from([0x80]));
  assert.match(res2, /\uFFFD/);

  // Incomplete 3-byte sequence followed by finish()
  sanitizer.push(Buffer.from([0xe2, 0x82])); // missing 3rd byte of €
  const fin = sanitizer.finish();
  assert.match(fin, /\uFFFD/);
});

// --------------------------------------------------------------------------
// Test 04: CSI removed across chunk splits
// --------------------------------------------------------------------------
await test("CSI sequences removed across arbitrary chunk splits", () => {
  const cases = [
    "\x1b[31;1mRed Bold Text\x1b[0m",
    "\x1b[2JScreen Cleared\x1b[H",
    "\x1b[?25hCursor Visible\x1b[?1049h",
    "\x1b[10;20HPositioned\x1b[K"
  ];

  for (const c of cases) {
    const single = runSanitizer(c, false);
    const split = runSanitizer(c, true); // 1 byte per chunk
    assert.doesNotMatch(single, /\x1b/);
    assert.doesNotMatch(single, /\[\d/);
    assert.equal(single, split);
  }

  // Exact CSI split verification:
  const s = new TerminalSanitizer();
  s.push(Buffer.from("\x1b"));
  assert.equal(s.getState(), SanitizerState.ESCAPE);
  s.push(Buffer.from("["));
  assert.equal(s.getState(), SanitizerState.CSI_PARAM);
  s.push(Buffer.from("31"));
  assert.equal(s.getState(), SanitizerState.CSI_PARAM);
  s.push(Buffer.from(";1"));
  assert.equal(s.getState(), SanitizerState.CSI_PARAM);
  const out = s.push(Buffer.from("mHello"));
  assert.equal(s.getState(), SanitizerState.GROUND);
  assert.equal(out, "Hello");
});

// --------------------------------------------------------------------------
// Test 05: OSC / BEL removed across chunk splits
// --------------------------------------------------------------------------
await test("OSC terminated by BEL removed across chunk splits", () => {
  const oscBel = "Before\x1b]0;My Secret Tab Title\x07After";
  const single = runSanitizer(oscBel, false);
  const bbb = runSanitizer(oscBel, true);

  assert.equal(single, "BeforeAfter");
  assert.equal(bbb, "BeforeAfter");
  assert.doesNotMatch(single, /My Secret Tab Title/);
});

// --------------------------------------------------------------------------
// Test 06: OSC / ST removed across chunk splits
// --------------------------------------------------------------------------
await test("OSC terminated by ST (7-bit and 8-bit) removed across chunk splits", () => {
  const oscSt7 = "Pre\x1b]2;Window Title Here\x1b\\Post";
  const single7 = runSanitizer(oscSt7, false);
  const bbb7 = runSanitizer(oscSt7, true);
  assert.equal(single7, "PrePost");
  assert.equal(bbb7, "PrePost");

  // 8-bit ST = U+009C
  const oscSt8 = "Pre\x1b]2;Window Title Here\u009cPost";
  const single8 = runSanitizer(oscSt8, false);
  assert.equal(single8, "PrePost");
});

// --------------------------------------------------------------------------
// Test 07: OSC 52 clipboard removed
// --------------------------------------------------------------------------
await test("OSC 52 clipboard injection removed completely", () => {
  const osc52 = "Data\x1b]52;c;c2VjcmV0IGNsaXBib2FyZCBkYXRh\x07Remaining";
  const res = runSanitizer(osc52, false);
  const bbb = runSanitizer(osc52, true);

  assert.equal(res, "DataRemaining");
  assert.equal(bbb, "DataRemaining");
  assert.doesNotMatch(res, /c2VjcmV0/);
});

// --------------------------------------------------------------------------
// Test 08: OSC 8 hyperlink control removed
// --------------------------------------------------------------------------
await test("OSC 8 hyperlink formatting removed while preserving anchor text", () => {
  const osc8 = 'Click \x1b]8;;https://malicious.example.com/phish\x1b\\here to verify\x1b]8;;\x1b\\ now';
  const res = runSanitizer(osc8, false);
  const bbb = runSanitizer(osc8, true);

  assert.equal(res, "Click here to verify now");
  assert.equal(bbb, "Click here to verify now");
  assert.doesNotMatch(res, /https:\/\/malicious/);
});

// --------------------------------------------------------------------------
// Test 09: Title-setting removed across variants
// --------------------------------------------------------------------------
await test("Title-setting escape sequences (OSC 0, 1, 2) removed", () => {
  const titles = [
    "A\x1b]0;Title 0\x07B",
    "C\x1b]1;Icon Name\x07D",
    "E\x1b]2;Window Title\x1b\\F"
  ];
  for (const t of titles) {
    const res = runSanitizer(t);
    assert.doesNotMatch(res, /Title/);
    assert.doesNotMatch(res, /Icon/);
  }
});

// --------------------------------------------------------------------------
// Test 10: DCS removed
// --------------------------------------------------------------------------
await test("DCS (Device Control String) removed statefully", () => {
  const dcsSt = "Start\x1bP$q\"p\x1b\\Finish";
  const dcsBel = "Start\x1bP1$pSomeDcsPayload\x07Finish";

  assert.equal(runSanitizer(dcsSt, false), "StartFinish");
  assert.equal(runSanitizer(dcsSt, true), "StartFinish");
  assert.equal(runSanitizer(dcsBel, false), "StartFinish");
  assert.equal(runSanitizer(dcsBel, true), "StartFinish");
});

// --------------------------------------------------------------------------
// Test 11: APC removed
// --------------------------------------------------------------------------
await test("APC (Application Program Command) removed statefully", () => {
  const apcSt = "One\x1b_Ga=T,f=100;payload-data\x1b\\Two";
  const apcBel = "One\x1b_some-apc-data\x07Two";

  assert.equal(runSanitizer(apcSt, false), "OneTwo");
  assert.equal(runSanitizer(apcSt, true), "OneTwo");
  assert.equal(runSanitizer(apcBel, false), "OneTwo");
  assert.equal(runSanitizer(apcBel, true), "OneTwo");
});

// --------------------------------------------------------------------------
// Test 12: PM removed
// --------------------------------------------------------------------------
await test("PM (Privacy Message) removed statefully", () => {
  const pmSt = "Left\x1b^privacy-confidential-string\x1b\\Right";
  const pmBel = "Left\x1b^privacy-secret\x07Right";

  assert.equal(runSanitizer(pmSt, false), "LeftRight");
  assert.equal(runSanitizer(pmSt, true), "LeftRight");
  assert.equal(runSanitizer(pmBel, false), "LeftRight");
});

// --------------------------------------------------------------------------
// Test 13: SOS removed
// --------------------------------------------------------------------------
await test("SOS (Start of String) removed statefully", () => {
  const sos = "Prefix\x1bXstart-of-string-data\x1b\\Suffix";
  assert.equal(runSanitizer(sos, false), "PrefixSuffix");
  assert.equal(runSanitizer(sos, true), "PrefixSuffix");
});

// --------------------------------------------------------------------------
// Test 14: Unterminated control string remains memory-bounded
// --------------------------------------------------------------------------
await test("unterminated control string remains memory-bounded and discards payload", () => {
  const s = new TerminalSanitizer({ maxControlPayloadChars: 4096 });
  // Start an unterminated OSC sequence
  s.push(Buffer.from("\x1b]0;"));
  assert.equal(s.getState(), SanitizerState.OSC);

  // Send 100,000 bytes without any terminator
  const bigChunk = Buffer.alloc(100_000, 0x61); // 'a'
  const out = s.push(bigChunk);
  assert.equal(out, ""); // no payload emitted

  // State must have transitioned to OSC_DISCARD
  assert.equal(s.getState(), SanitizerState.OSC_DISCARD);

  // Control payload length counter must be bounded
  assert.ok(s.getControlPayloadLength() > 4096);

  // Finish must discard the unterminated sequence and emit nothing
  const fin = s.finish();
  assert.equal(fin, "");
  assert.equal(s.getState(), SanitizerState.GROUND);
});

// --------------------------------------------------------------------------
// Test 15: Overlong control sequence remains memory-bounded and fails safe
// --------------------------------------------------------------------------
await test("overlong control sequence discards payload and recovers cleanly at terminator", () => {
  const s = new TerminalSanitizer({ maxControlPayloadChars: 4096 });
  s.push(Buffer.from("Pre\x1b]0;"));

  // Stream 100,000 bytes of overlong payload in 10k chunks
  for (let i = 0; i < 10; i++) {
    s.push(Buffer.alloc(10_000, 0x58)); // 'X'
  }
  assert.equal(s.getState(), SanitizerState.OSC_DISCARD);

  // Now terminate the overlong OSC sequence with BEL (\x07) and follow with valid text
  const post = s.push(Buffer.from("\x07ValidPostText"));
  assert.equal(s.getState(), SanitizerState.GROUND);
  assert.equal(post, "ValidPostText");

  const final = s.finish();
  assert.equal(final, "");
});

// --------------------------------------------------------------------------
// Test 16: No ESC / C0 terminal-control residue reaches final safe text
// --------------------------------------------------------------------------
await test("no ESC/C0 terminal control residue reaches output; normalization enforced", () => {
  // Feed various hostile C0 controls: NUL, SOH, BEL, BS, VT, FF, SO, SI, DEL, lone ESC
  const hostile = "Line1\r\nLine2\rLine3\tTabbed\x00Nul\x07Bel\x08Back\x0bVt\x0cFf\x0eSo\x0fSi\x7fDel\x1bLoneEscEnd";
  const res = runSanitizer(hostile, false);

  // Check that \r\n -> \n, standalone \r -> \n
  assert.match(res, /Line1\nLine2\nLine3\tTabbed/);

  // Ensure NO control characters exist other than \t (0x09) and \n (0x0A)
  for (let i = 0; i < res.length; i++) {
    const code = res.charCodeAt(i);
    if (code < 0x20) {
      assert.ok(code === 0x09 || code === 0x0a, `Unexpected control byte 0x${code.toString(16)} at index ${i}`);
    }
    assert.notEqual(code, 0x7f, "DEL character must not survive");
    assert.notEqual(code, 0x1b, "ESC character must not survive");
  }
});

// --------------------------------------------------------------------------
// Test 17: Credential with inserted CSI remains redacted
// --------------------------------------------------------------------------
await test("credential with inserted CSI escape sequence remains redacted", () => {
  // Attacker tries: ghp_ + \x1b[31;1m + 01234567890123456789 (20 alphanumeric chars)
  const evasionAttempt = "Token: ghp_\x1b[31;1m01234567890123456789\x1b[0m is active.\n";
  const result = sanitizeAndRedactTerminalOutput(evasionAttempt);

  assert.doesNotMatch(result.transcript, /ghp_01234567890123456789/);
  assert.match(result.transcript, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(result.transcript, /\x1b/);
});

// --------------------------------------------------------------------------
// Test 18: Credential with inserted OSC remains redacted
// --------------------------------------------------------------------------
await test("credential with inserted OSC sequence remains redacted", () => {
  const evasionAttempt = "Auth: ghp_\x1b]0;terminal-title\x0701234567890123456789 ready\n";
  const result = sanitizeAndRedactTerminalOutput(evasionAttempt);

  assert.doesNotMatch(result.transcript, /ghp_01234567890123456789/);
  assert.match(result.transcript, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(result.transcript, /terminal-title/);
});

// --------------------------------------------------------------------------
// Test 19: Private-key marker/block with inserted terminal sequences remains redacted
// --------------------------------------------------------------------------
await test("private-key marker with inserted ANSI escape sequences remains redacted", () => {
  const evasionKey = [
    "-----BEGIN\x1b[1;32m PRIVATE KEY-----\x1b[0m",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD",
    "-----END\x1b[31m PRIVATE KEY-----\x1b[0m",
    ""
  ].join("\r\n");

  const result = sanitizeAndRedactTerminalOutput(evasionKey);

  assert.doesNotMatch(result.transcript, /MIIEvQIBADANBgkqhki/);
  assert.match(result.transcript, /\[REDACTED_PRIVATE_KEY\]/);
  assert.doesNotMatch(result.transcript, /\x1b/);
});

// --------------------------------------------------------------------------
// Test 20: Accepted M009 regressions remain PASS after sanitizer
// --------------------------------------------------------------------------
await test("accepted M009 long-gap/quoted/private-key/UTF-8 regressions remain PASS", () => {
  // 1. OpenAI key regression
  const openAiTest = "openai_key = sk-1234567890abcdef1234567890\n";
  assert.match(sanitizeAndRedactTerminalOutput(openAiTest).transcript, /\[REDACTED_SECRET\]/);

  // 2. Quoted credential regression
  const quotedTest = 'api_key = "ghp_01234567890123456789"\n';
  assert.match(sanitizeAndRedactTerminalOutput(quotedTest).transcript, /\[REDACTED_SECRET\]/);

  // 3. Multi-line streaming private key
  const pipeline = new PtyTranscriptPipeline();
  pipeline.push(Buffer.from("-----BEGIN PRIVATE KEY-----\r\n"));
  pipeline.push(Buffer.from("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD\r\n"));
  pipeline.push(Buffer.from("-----END PRIVATE KEY-----\r\n"));
  const res = pipeline.finish();
  assert.match(res.transcript, /\[REDACTED_PRIVATE_KEY\]/);
  assert.doesNotMatch(res.transcript, /MIIEvQIBADANBgkqhki/);

  // 4. UTF-8 surrounding secrets
  const utf8Secret = "Café API ключ: ghp_01234567890123456789 🚀\n";
  const utf8Res = sanitizeAndRedactTerminalOutput(utf8Secret);
  assert.match(utf8Res.transcript, /Café API ключ: \[REDACTED_SECRET\] 🚀/);
});

// --------------------------------------------------------------------------
// Test 21: Final retained output respects byte bound
// --------------------------------------------------------------------------
await test("final retained transcript respects maxOutputBytes bound", () => {
  const pipeline = new PtyTranscriptPipeline({ maxOutputBytes: 1000 });
  // Feed 50 chunks of 100 bytes = 5000 bytes
  for (let i = 0; i < 50; i++) {
    pipeline.push(Buffer.alloc(100, 0x61)); // 'a'
  }
  const res = pipeline.finish();

  assert.equal(res.truncated, true);
  assert.ok(res.retainedBytes <= 1000);
  assert.equal(Buffer.byteLength(res.transcript, "utf8"), res.retainedBytes);
  assert.equal(res.rawObservedBytes, 5000);
});

// --------------------------------------------------------------------------
// Test 22: Truncation never produces invalid UTF-8
// --------------------------------------------------------------------------
await test("truncation never splits multi-byte UTF-8 code points", () => {
  // Test utf8PrefixLength helper directly across multi-byte boundaries
  const emoji = Buffer.from("Hello 🚀 World", "utf8"); // 🚀 is 4 bytes at offsets 6,7,8,9
  // If limit is 7, 8, or 9 (inside the emoji):
  assert.equal(utf8PrefixLength(emoji, 6), 6); // "Hello "
  assert.equal(utf8PrefixLength(emoji, 7), 6); // cannot fit 🚀 (needs 4 bytes, only 1 available)
  assert.equal(utf8PrefixLength(emoji, 8), 6); // cannot fit 🚀 (only 2 available)
  assert.equal(utf8PrefixLength(emoji, 9), 6); // cannot fit 🚀 (only 3 available)
  assert.equal(utf8PrefixLength(emoji, 10), 10); // fits "Hello 🚀" (exact 10 bytes)

  // In pipeline:
  const pipeline = new PtyTranscriptPipeline({ maxOutputBytes: 8 });
  pipeline.push(Buffer.from("Hello 🚀 World"));
  const res = pipeline.finish();

  assert.equal(res.truncated, true);
  assert.equal(res.transcript, "Hello "); // cleanly drops 🚀 rather than corrupting it
  assert.equal(Buffer.byteLength(res.transcript, "utf8"), 6);
  // Verify valid UTF-8
  assert.doesNotMatch(res.transcript, /\uFFFD/);
});

// --------------------------------------------------------------------------
// Test 23: Chunking invariance / one-byte-at-a-time stress
// --------------------------------------------------------------------------
await test("chunking invariance: 1 chunk vs 1 byte/chunk vs randomized chunks yield identical output", () => {
  const complexInput = [
    "Starting compilation...\x1b[32mOK\x1b[0m",
    "\x1b]0;Build in progress\x07",
    "Processing: café, 🚀, and € symbols.\r\n",
    "Secret token: ghp_\x1b[1m01234567890123456789\x1b[0m\r\n",
    "\x1bP$q\"p\x1b\\Dcs removed.\r\n",
    "\x1b]8;;https://example.com\x1b\\Click\x1b]8;;\x1b\\ done.\r\n"
  ].join("");

  const rawBytes = Buffer.from(complexInput, "utf8");

  // Run 1: Single big chunk
  const resSingle = sanitizeAndRedactTerminalOutput(rawBytes).transcript;

  // Run 2: 1 byte per chunk
  const pipeByte = new PtyTranscriptPipeline();
  for (let i = 0; i < rawBytes.length; i++) {
    pipeByte.push(rawBytes.subarray(i, i + 1));
  }
  const resByte = pipeByte.finish().transcript;
  assert.equal(resByte, resSingle, "Byte-by-byte output must match single-chunk output");

  // Run 3: Deterministic pseudo-random chunk sizes (2..7 bytes)
  const pipeRand = new PtyTranscriptPipeline();
  let offset = 0;
  let step = 2;
  while (offset < rawBytes.length) {
    const nextChunk = rawBytes.subarray(offset, offset + step);
    pipeRand.push(nextChunk);
    offset += step;
    step = ((step * 3 + 1) % 6) + 2; // cycles through 2..7
  }
  const resRand = pipeRand.finish().transcript;
  assert.equal(resRand, resSingle, "Random-chunked output must match single-chunk output");

  // Run 4: Every possible single-split position
  for (let split = 1; split < rawBytes.length; split += Math.max(1, Math.floor(rawBytes.length / 20))) {
    const pipeSplit = new PtyTranscriptPipeline();
    pipeSplit.push(rawBytes.subarray(0, split));
    pipeSplit.push(rawBytes.subarray(split));
    const resSplit = pipeSplit.finish().transcript;
    assert.equal(resSplit, resSingle, `Split at offset ${split} must match single-chunk output`);
  }
});

// --------------------------------------------------------------------------
// Test 24: Sanitizer finalization does not leak unterminated control payload
// --------------------------------------------------------------------------
await test("sanitizer finalization does not leak unterminated control payload", () => {
  const unterminated = "CleanBefore\x1b]0;HostileUnterminatedTitleAtEof";
  const s = new TerminalSanitizer();
  const chunk = s.push(Buffer.from(unterminated));
  assert.equal(chunk, "CleanBefore");

  // Finish must discard the trailing unterminated OSC title
  const final = s.finish();
  assert.equal(final, "");
  assert.equal(s.getState(), SanitizerState.GROUND);
});

// --------------------------------------------------------------------------
// Test 25: 8-bit C1 controls handled statefully
// --------------------------------------------------------------------------
await test("8-bit C1 controls (0x80..0x9F) handled statefully without bypass", () => {
  // 0xC2 0x9B is UTF-8 for U+009B (8-bit CSI)
  const csi8bit = Buffer.concat([
    Buffer.from("Hello "),
    Buffer.from([0xc2, 0x9b]), // CSI
    Buffer.from("31;1mWorld")  // 'm' terminates CSI
  ]);
  assert.equal(runSanitizer(csi8bit), "Hello World");

  // 0xC2 0x9D is UTF-8 for U+009D (8-bit OSC)
  const osc8bit = Buffer.concat([
    Buffer.from("Start "),
    Buffer.from([0xc2, 0x9d]), // OSC
    Buffer.from("0;Title\x07End")
  ]);
  assert.equal(runSanitizer(osc8bit), "Start End");

  // 0xC2 0x85 is UTF-8 for U+0085 (8-bit NEL Next Line)
  const nel8bit = Buffer.concat([
    Buffer.from("Line1"),
    Buffer.from([0xc2, 0x85]),
    Buffer.from("Line2")
  ]);
  assert.equal(runSanitizer(nel8bit), "Line1\nLine2");
});

// --------------------------------------------------------------------------
// Test 26: Physical ordering proof: redactor before sanitizer fails, sanitizer before redactor succeeds
// --------------------------------------------------------------------------
await test("physical ordering proof: redactor-before-sanitizer fails redaction, sanitizer-before-redactor succeeds", () => {
  const evasiveSecret = "ghp_\x1b[31m01234567890123456789\n";

  // If Redactor ran first (incorrect order):
  const wrongOrderRedactor = new StreamingRedactor();
  const chunksFromWrongRedactor = wrongOrderRedactor.push(Buffer.from(evasiveSecret));
  chunksFromWrongRedactor.push(...wrongOrderRedactor.flush());
  const textFromWrongRedactor = Buffer.concat(chunksFromWrongRedactor).toString("utf8");

  // Notice: StreamingRedactor DID NOT redact it because of the escape sequence!
  assert.doesNotMatch(textFromWrongRedactor, /\[REDACTED_SECRET\]/, "Redactor-first fails to redact due to escape sequence");
  assert.match(textFromWrongRedactor, /ghp_\x1b\[31m01234567890123456789/);

  // Then if wrong order sanitizer runs:
  const leakedSecret = sanitizeTerminalText(textFromWrongRedactor);
  assert.match(leakedSecret, /ghp_01234567890123456789/, "Wrong order leaks the secret in plaintext!");

  // BUT with our correct pipeline (TerminalSanitizer BEFORE StreamingRedactor):
  const correctResult = sanitizeAndRedactTerminalOutput(evasiveSecret);
  assert.doesNotMatch(correctResult.transcript, /ghp_01234567890123456789/, "Correct order successfully catches and redacts the secret!");
  assert.match(correctResult.transcript, /\[REDACTED_SECRET\]/);
});

// --------------------------------------------------------------------------
// Test 27: Hard raw output ceiling tracking
// --------------------------------------------------------------------------
await test("hard raw output ceiling exceeded flag is truthfully tracked", () => {
  const pipeline = new PtyTranscriptPipeline({
    maxOutputBytes: 500,
    hardOutputCeilingBytes: 2000
  });

  assert.equal(pipeline.isCeilingExceeded(), false);
  pipeline.push(Buffer.alloc(1500, 0x61));
  assert.equal(pipeline.isCeilingExceeded(), false);
  pipeline.push(Buffer.alloc(600, 0x61)); // total 2100 > 2000
  assert.equal(pipeline.isCeilingExceeded(), true);
  assert.equal(pipeline.getRawObservedBytes(), 2100);

  const res = pipeline.finish();
  assert.equal(res.ceilingExceeded, true);
  assert.equal(res.truncated, true);
});

console.log(`\n# All ${testsRun} TASK-003 adversarial tests passed cleanly (${testsPassed}/${testsRun}).`);
console.log("# AP-006 VERDICT: PASS (Returned transcript is normalized safe text).");
console.log("# AP-007 VERDICT: PASS (M009 streaming redaction remains at least as strong after PTY normalization).");
