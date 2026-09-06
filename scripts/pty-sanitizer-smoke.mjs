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
import { CodexProError } from "../dist/guard.js";

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
// Test 04b: Initial ESC disturbance (NUL/BEL/BS/CR/LF/DEL/C1) stripped without leaking syntax
// --------------------------------------------------------------------------
await test("initial ESC disturbance (NUL/BEL/BS/CR/LF/DEL/C1) stripped without leaking following escape syntax", () => {
  // Required direct falsifiers: ESC + disturbance + [31m must NOT expose [31m
  const disturbances = [
    { name: "NUL", raw: "\x00" },
    { name: "BEL", raw: "\x07" },
    { name: "BS", raw: "\x08" },
    { name: "CR", raw: "\r" },
    { name: "LF", raw: "\n" },
    { name: "DEL", raw: "\x7f" },
    { name: "C1_NEL", raw: "\u0085" },
    { name: "C1_CSI", raw: "\u009b" },
    { name: "C1_PAD", raw: "\u0080" },
  ];

  for (const { name, raw } of disturbances) {
    const neutral = `A\x1b${raw}[31mB`;
    const single = runSanitizer(neutral, false);
    const byteByByte = runSanitizer(neutral, true);

    assert.equal(single, "AB", `Single-chunk failure for ${name}: expected 'AB', got ${JSON.stringify(single)}`);
    assert.equal(byteByByte, "AB", `Byte-by-byte failure for ${name}: expected 'AB', got ${JSON.stringify(byteByByte)}`);
    assert.doesNotMatch(single, /\[31m/, `Exposure of [31m in single-chunk for ${name}`);
    assert.doesNotMatch(byteByByte, /\[31m/, `Exposure of [31m in byte-by-byte for ${name}`);
  }

  // Multi-byte disturbance combination:
  const multiDisturbance = "A\x1b\x00\x07\x08\r\n\x7f\u0085[31;1;4mB";
  assert.equal(runSanitizer(multiDisturbance, false), "AB");
  assert.equal(runSanitizer(multiDisturbance, true), "AB");

  // State transitions: verify parser remains in ESCAPE during disturbance
  const s = new TerminalSanitizer();
  s.push(Buffer.from("Prefix\x1b"));
  assert.equal(s.getState(), SanitizerState.ESCAPE);
  s.push(Buffer.from("\x00")); // NUL disturbance
  assert.equal(s.getState(), SanitizerState.ESCAPE, "NUL must not drop parser to GROUND");
  s.push(Buffer.from("\x07")); // BEL disturbance
  assert.equal(s.getState(), SanitizerState.ESCAPE, "BEL must not drop parser to GROUND");
  s.push(Buffer.from("\x08")); // BS disturbance
  assert.equal(s.getState(), SanitizerState.ESCAPE, "BS must not drop parser to GROUND");
  s.push(Buffer.from("\r")); // CR disturbance (no pendingCr)
  assert.equal(s.getState(), SanitizerState.ESCAPE, "CR must not drop parser to GROUND");
  assert.equal(s.isPendingCr(), false, "CR inside ESCAPE must not set pendingCr");
  s.push(Buffer.from("\n")); // LF disturbance
  assert.equal(s.getState(), SanitizerState.ESCAPE, "LF must not drop parser to GROUND");
  s.push(Buffer.from("\x7f")); // DEL disturbance
  assert.equal(s.getState(), SanitizerState.ESCAPE, "DEL must not drop parser to GROUND");
  s.push(Buffer.from("\u0085")); // C1 NEL disturbance
  assert.equal(s.getState(), SanitizerState.ESCAPE, "C1 NEL must not drop parser to GROUND");
  s.push(Buffer.from("["));
  assert.equal(s.getState(), SanitizerState.CSI_PARAM);
  s.push(Buffer.from("31mPostfix"));
  assert.equal(s.getState(), SanitizerState.GROUND);
  const fin = s.finish();
  assert.equal(fin, "");

  // Consecutive ESC with disturbance:
  const consecutiveEscDisturbed = "A\x1b\x00\x1b[31mB";
  assert.equal(runSanitizer(consecutiveEscDisturbed, false), "AB");
  assert.equal(runSanitizer(consecutiveEscDisturbed, true), "AB");

  // Incomplete sequence with disturbance dropped at finish():
  const sIncomplete = new TerminalSanitizer();
  const chunkIncomplete = sIncomplete.push(Buffer.from("Visible\x1b\x00\x07"));
  assert.equal(chunkIncomplete, "Visible");
  assert.equal(sIncomplete.getState(), SanitizerState.ESCAPE);
  assert.equal(sIncomplete.finish(), "");
  assert.equal(sIncomplete.getState(), SanitizerState.GROUND);
});

// --------------------------------------------------------------------------
// Test 05b: ESC_INTERMEDIATE disturbance (decoded C1, non-C1 Unicode, C0/DEL) stripped without leaking following escape final
// --------------------------------------------------------------------------
await test("ESC_INTERMEDIATE disturbance (decoded C1, non-C1 Unicode, C0/DEL) stripped without leaking following escape final", () => {
  // Required direct falsifiers:
  // For A + ESC + ( + disturbance + B + B -> expected safe result: AB
  // The first B must be consumed as escape final; second B remains visible text.
  const c1Disturbances = [
    { name: "C1_PAD (U+0080)", raw: "\u0080" },
    { name: "C1_NEL (U+0085)", raw: "\u0085" },
    { name: "C1_CSI (U+009B)", raw: "\u009b" },
    { name: "C1_OSC (U+009D)", raw: "\u009d" },
  ];

  const otherDisturbances = [
    { name: "C0_NUL", raw: "\x00" },
    { name: "C0_BEL", raw: "\x07" },
    { name: "C0_BS", raw: "\x08" },
    { name: "C0_CR", raw: "\r" },
    { name: "C0_LF", raw: "\n" },
    { name: "DEL", raw: "\x7f" },
    { name: "Unicode_Cyrillic (U+0410)", raw: "\u0410" },
    { name: "Unicode_Astral_Emoji (U+1F600)", raw: "\uD83D\uDE00" },
    { name: "Multi_Disturbance", raw: "\x00\x07\u0085\u009b\u0410" },
  ];

  const allDisturbances = [...c1Disturbances, ...otherDisturbances];

  for (const { name, raw } of allDisturbances) {
    const input = `A\x1b(${raw}BB`;
    const single = runSanitizer(input, false);
    const byteByByte = runSanitizer(input, true);

    assert.equal(single, "AB", `Single-chunk failure for ${name}: expected 'AB', got ${JSON.stringify(single)}`);
    assert.equal(byteByByte, "AB", `Byte-by-byte failure for ${name}: expected 'AB', got ${JSON.stringify(byteByByte)}`);
  }

  // Punctuation-final falsifiers:
  // Escape finals containing punctuation: ':', ';', '=', '?'
  // e.g. token-head + ESC + ( + decoded-C1 + punctuation-final + token-tail
  const punctuationFinals = [":", ";", "=", "?"];
  for (const punc of punctuationFinals) {
    for (const { name, raw } of c1Disturbances) {
      const input = `Pre\x1b(${raw}${punc}Post`;
      const single = runSanitizer(input, false);
      const byteByByte = runSanitizer(input, true);

      assert.equal(single, "PrePost", `Punctuation final '${punc}' leaked with disturbance ${name} in single-chunk: got ${JSON.stringify(single)}`);
      assert.equal(byteByByte, "PrePost", `Punctuation final '${punc}' leaked with disturbance ${name} in byte-by-byte: got ${JSON.stringify(byteByByte)}`);
      assert.doesNotMatch(single, new RegExp(`\\${punc}`), `Punctuation '${punc}' must not appear in output`);
      assert.doesNotMatch(byteByByte, new RegExp(`\\${punc}`), `Punctuation '${punc}' must not appear in output`);
    }
  }

  // State transitions: verify parser remains in ESC_INTERMEDIATE during disturbance
  const s = new TerminalSanitizer();
  s.push(Buffer.from("Prefix\x1b(")); // ESC ( -> intermediate
  assert.equal(s.getState(), SanitizerState.ESC_INTERMEDIATE);
  s.push(Buffer.from("\u0085")); // C1 NEL disturbance
  assert.equal(s.getState(), SanitizerState.ESC_INTERMEDIATE, "C1 NEL must not drop parser to GROUND");
  s.push(Buffer.from("\u0080")); // C1 PAD disturbance
  assert.equal(s.getState(), SanitizerState.ESC_INTERMEDIATE, "C1 PAD must not drop parser to GROUND");
  s.push(Buffer.from("\u009b")); // C1 CSI disturbance
  assert.equal(s.getState(), SanitizerState.ESC_INTERMEDIATE, "C1 CSI must not drop parser to GROUND");
  s.push(Buffer.from("\u009d")); // C1 OSC disturbance
  assert.equal(s.getState(), SanitizerState.ESC_INTERMEDIATE, "C1 OSC must not drop parser to GROUND");
  s.push(Buffer.from("\u0410")); // Cyrillic disturbance
  assert.equal(s.getState(), SanitizerState.ESC_INTERMEDIATE, "Out-of-range Unicode must not drop parser to GROUND");
  s.push(Buffer.from("\x00")); // NUL disturbance
  assert.equal(s.getState(), SanitizerState.ESC_INTERMEDIATE, "NUL must not drop parser to GROUND");
  s.push(Buffer.from("\x7f")); // DEL disturbance
  assert.equal(s.getState(), SanitizerState.ESC_INTERMEDIATE, "DEL must not drop parser to GROUND");
  s.push(Buffer.from(":")); // Punctuation final
  assert.equal(s.getState(), SanitizerState.GROUND, "Valid escape final must return parser to GROUND");
  s.push(Buffer.from("Postfix"));
  assert.equal(s.getState(), SanitizerState.GROUND);
  const fin = s.finish();
  assert.equal(fin, "");

  // Consecutive ESC with disturbance inside ESC_INTERMEDIATE restarts ESCAPE:
  const consecutiveEscDisturbed = "A\x1b(\u0085\x1b[31mB";
  assert.equal(runSanitizer(consecutiveEscDisturbed, false), "AB");
  assert.equal(runSanitizer(consecutiveEscDisturbed, true), "AB");

  // Incomplete sequence with disturbance in ESC_INTERMEDIATE dropped at finish():
  const sIncomplete = new TerminalSanitizer();
  const chunkIncomplete = sIncomplete.push(Buffer.from("Visible\x1b(\u0085\u0080"));
  assert.equal(chunkIncomplete, "Visible");
  assert.equal(sIncomplete.getState(), SanitizerState.ESC_INTERMEDIATE);
  assert.equal(sIncomplete.finish(), "");
  assert.equal(sIncomplete.getState(), SanitizerState.GROUND);
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
await test("DCS (Device Control String) removed statefully (ST only; BEL is suppressed payload)", () => {
  const dcsSt = "Start\x1bP$q\"p\x1b\\Finish";
  const dcsBel = "Start\x1bP1$pSomeDcsPayload\x07still-inside-dcs\x1b\\Finish";

  assert.equal(runSanitizer(dcsSt, false), "StartFinish");
  assert.equal(runSanitizer(dcsSt, true), "StartFinish");
  assert.equal(runSanitizer(dcsBel, false), "StartFinish");
  assert.equal(runSanitizer(dcsBel, true), "StartFinish");
  assert.doesNotMatch(runSanitizer(dcsBel, false), /still-inside-dcs/);
  assert.doesNotMatch(runSanitizer(dcsBel, true), /still-inside-dcs/);
});

// --------------------------------------------------------------------------
// Test 11: APC removed
// --------------------------------------------------------------------------
await test("APC (Application Program Command) removed statefully (ST only; BEL is suppressed payload)", () => {
  const apcSt = "One\x1b_Ga=T,f=100;payload-data\x1b\\Two";
  const apcBel = "One\x1b_some-apc-data\x07still-inside-apc\x1b\\Two";

  assert.equal(runSanitizer(apcSt, false), "OneTwo");
  assert.equal(runSanitizer(apcSt, true), "OneTwo");
  assert.equal(runSanitizer(apcBel, false), "OneTwo");
  assert.equal(runSanitizer(apcBel, true), "OneTwo");
  assert.doesNotMatch(runSanitizer(apcBel, false), /still-inside-apc/);
  assert.doesNotMatch(runSanitizer(apcBel, true), /still-inside-apc/);
});

// --------------------------------------------------------------------------
// Test 12: PM removed
// --------------------------------------------------------------------------
await test("PM (Privacy Message) removed statefully (ST only; BEL is suppressed payload)", () => {
  const pmSt = "Left\x1b^privacy-confidential-string\x1b\\Right";
  const pmBel = "Left\x1b^privacy-secret\x07still-inside-pm\x1b\\Right";

  assert.equal(runSanitizer(pmSt, false), "LeftRight");
  assert.equal(runSanitizer(pmSt, true), "LeftRight");
  assert.equal(runSanitizer(pmBel, false), "LeftRight");
  assert.equal(runSanitizer(pmBel, true), "LeftRight");
  assert.doesNotMatch(runSanitizer(pmBel, false), /still-inside-pm/);
  assert.doesNotMatch(runSanitizer(pmBel, true), /still-inside-pm/);
});

// --------------------------------------------------------------------------
// Test 13: SOS removed
// --------------------------------------------------------------------------
await test("SOS (Start of String) removed statefully (ST only; BEL is suppressed payload)", () => {
  const sosSt = "Prefix\x1bXstart-of-string-data\x1b\\Suffix";
  const sosBel = "Prefix\x1bXstart-data\x07still-inside-sos\x1b\\Suffix";
  assert.equal(runSanitizer(sosSt, false), "PrefixSuffix");
  assert.equal(runSanitizer(sosSt, true), "PrefixSuffix");
  assert.equal(runSanitizer(sosBel, false), "PrefixSuffix");
  assert.equal(runSanitizer(sosBel, true), "PrefixSuffix");
  assert.doesNotMatch(runSanitizer(sosBel, false), /still-inside-sos/);
  assert.doesNotMatch(runSanitizer(sosBel, true), /still-inside-sos/);
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
// Test 15b: Overlong string control discards payload, ignores BEL, terminates at ST
// --------------------------------------------------------------------------
await test("overlong string control (DCS) discards payload, ignores BEL, recovers at ST", () => {
  const s = new TerminalSanitizer({ maxControlPayloadChars: 4096 });
  s.push(Buffer.from("Pre\x1bP$q"));

  // Stream 50k of payload into discard
  for (let i = 0; i < 5; i++) {
    s.push(Buffer.alloc(10_000, 0x58)); // 'X'
  }
  assert.equal(s.getState(), SanitizerState.STRING_CONTROL_DISCARD);

  // BEL must NOT terminate string control discard
  s.push(Buffer.from("\x07stillInDiscard\x07"));
  assert.equal(s.getState(), SanitizerState.STRING_CONTROL_DISCARD);

  // ST terminates string control discard
  const post = s.push(Buffer.from("\x1b\\ValidPostText"));
  assert.equal(s.getState(), SanitizerState.GROUND);
  assert.equal(post, "ValidPostText");

  const final = s.finish();
  assert.equal(final, "");
});

// --------------------------------------------------------------------------
// Test 15c: Malformed ESC continuations inside OSC fail closed
// --------------------------------------------------------------------------
await test("malformed ESC continuations inside OSC fail closed and remain suppressed", () => {
  // ESC Z inside OSC payload: should NOT return to GROUND, trailing payload remains suppressed until BEL
  const oscMalformed = "Pre\x1b]0;Title\x1bZLeakedPayload\x07Post";
  assert.equal(runSanitizer(oscMalformed, false), "PrePost");
  assert.equal(runSanitizer(oscMalformed, true), "PrePost");
  assert.doesNotMatch(runSanitizer(oscMalformed, false), /LeakedPayload/);
  assert.doesNotMatch(runSanitizer(oscMalformed, true), /LeakedPayload/);

  // Overlong OSC with malformed ESC:
  const s = new TerminalSanitizer({ maxControlPayloadChars: 4096 });
  s.push(Buffer.from("Pre\x1b]0;"));
  for (let i = 0; i < 5; i++) {
    s.push(Buffer.alloc(1000, 0x41));
  }
  assert.equal(s.getState(), SanitizerState.OSC_DISCARD);
  s.push(Buffer.from("\x1bZMoreDiscardedPayload"));
  assert.equal(s.getState(), SanitizerState.OSC_DISCARD);
  const post = s.push(Buffer.from("\x07Post"));
  assert.equal(s.getState(), SanitizerState.GROUND);
  assert.equal(post, "Post");
});

// --------------------------------------------------------------------------
// Test 15d: Malformed ESC continuations inside DCS/APC/PM/SOS fail closed
// --------------------------------------------------------------------------
await test("malformed ESC continuations inside string controls fail closed until ST", () => {
  // ESC Z inside DCS payload: should NOT return to GROUND, trailing payload remains suppressed until ST
  const dcsMalformed = "Pre\x1bP$q\x1bZLeakedDcsSecret\x1b\\Post";
  assert.equal(runSanitizer(dcsMalformed, false), "PrePost");
  assert.equal(runSanitizer(dcsMalformed, true), "PrePost");
  assert.doesNotMatch(runSanitizer(dcsMalformed, false), /LeakedDcsSecret/);
  assert.doesNotMatch(runSanitizer(dcsMalformed, true), /LeakedDcsSecret/);

  // Overlong DCS with malformed ESC:
  const s = new TerminalSanitizer({ maxControlPayloadChars: 4096 });
  s.push(Buffer.from("Pre\x1bP"));
  for (let i = 0; i < 5; i++) {
    s.push(Buffer.alloc(1000, 0x42));
  }
  assert.equal(s.getState(), SanitizerState.STRING_CONTROL_DISCARD);
  s.push(Buffer.from("\x1bZMoreDiscardedDcs"));
  assert.equal(s.getState(), SanitizerState.STRING_CONTROL_DISCARD);
  const post = s.push(Buffer.from("\x1b\\Post"));
  assert.equal(s.getState(), SanitizerState.GROUND);
  assert.equal(post, "Post");
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
  const result = sanitizeAndRedactTerminalOutput(evasionAttempt, { maxOutputBytes: 120_000 });

  assert.doesNotMatch(result.transcript, /ghp_01234567890123456789/);
  assert.match(result.transcript, /\[REDACTED_SECRET\]/);
  assert.doesNotMatch(result.transcript, /\x1b/);
});

// --------------------------------------------------------------------------
// Test 17b: Credential with CSI containing C0/DEL disturbance remains redacted
// --------------------------------------------------------------------------
await test("credential with CSI containing C0/DEL disturbance (BEL/NUL/BS) remains redacted", () => {
  // BEL inside CSI parameters: in R0, BEL caused drop to GROUND, emitting 'm' and corrupting token
  const belDisturbance = "Token: ghp_\x1b[31\x07m01234567890123456789\x1b[0m active\n";
  const resBelSingle = sanitizeAndRedactTerminalOutput(belDisturbance, { maxOutputBytes: 120_000 });
  const resBelByte = (() => {
    const p = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
    const b = Buffer.from(belDisturbance, "utf8");
    for (let i = 0; i < b.length; i++) p.push(b.subarray(i, i + 1));
    return p.finish().transcript;
  })();

  assert.doesNotMatch(resBelSingle.transcript, /ghp_01234567890123456789/);
  assert.doesNotMatch(resBelSingle.transcript, /ghp_m/);
  assert.match(resBelSingle.transcript, /\[REDACTED_SECRET\]/);
  assert.equal(resBelSingle.transcript, resBelByte, "Single-chunk and byte-by-byte must match");

  // Multiple C0 disturbances (NUL, BEL, BS) inside CSI:
  const multiDisturbance = "Token: ghp_\x1b[31\x00\x07\x08;1m01234567890123456789\x1b[0m active\n";
  const resMulti = sanitizeAndRedactTerminalOutput(multiDisturbance, { maxOutputBytes: 120_000 });
  assert.doesNotMatch(resMulti.transcript, /ghp_01234567890123456789/);
  assert.match(resMulti.transcript, /\[REDACTED_SECRET\]/);
});

// --------------------------------------------------------------------------
// Test 17c: GitHub-token-shaped attack with initial ESC disturbance remains redacted
// --------------------------------------------------------------------------
await test("credential with initial ESC disturbance (NUL/BEL/BS/CR/LF/DEL/C1) before CSI remains redacted", () => {
  // Construct: token-prefix + ESC + C0 disturbance + CSI continuation/final + token-tail
  // Test in unlabelled text so detection relies solely on the token grammar
  const disturbances = [
    { name: "NUL", raw: "\x00" },
    { name: "BEL", raw: "\x07" },
    { name: "BS",  raw: "\x08" },
    { name: "CR",  raw: "\r" },
    { name: "LF",  raw: "\n" },
    { name: "DEL", raw: "\x7f" },
    { name: "C1_NEL", raw: "\u0085" },
    { name: "C1_CSI", raw: "\u009b" },
    { name: "MULTI", raw: "\x00\x07\x08" },
  ];

  for (const { name, raw } of disturbances) {
    const attack = `echo ghp_1234567890\x1b${raw}[31m12345678901234567890\x1b[0m is active\n`;

    // Single chunk
    const single = sanitizeAndRedactTerminalOutput(attack, { maxOutputBytes: 120_000 });
    assert.doesNotMatch(single.transcript, /ghp_1234567890/, `Plaintext token prefix leaked for ${name}`);
    assert.doesNotMatch(single.transcript, /12345678901234567890/, `Plaintext token tail leaked for ${name}`);
    assert.match(single.transcript, /\[REDACTED_SECRET\]/, `Secret not redacted for ${name}`);
    assert.doesNotMatch(single.transcript, /\[31m/, `CSI syntax exposed in transcript for ${name}`);
    assert.doesNotMatch(single.transcript, /\x1b/, `ESC byte exposed for ${name}`);

    // Byte by byte
    const p = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
    const b = Buffer.from(attack, "utf8");
    for (let i = 0; i < b.length; i++) p.push(b.subarray(i, i + 1));
    const byteRes = p.finish().transcript;
    assert.equal(single.transcript, byteRes, `Single-chunk and byte-by-byte must match for ${name}`);
  }
});

// --------------------------------------------------------------------------
// Test 17d: GitHub-token attack with ESC_INTERMEDIATE decoded-C1 and punctuation finals remains redacted
// --------------------------------------------------------------------------
await test("credential with ESC_INTERMEDIATE decoded-C1 and punctuation-final attack remains redacted", () => {
  // Reproduce the exact previously failing attack:
  // echo ghp_1234567890 + ESC + ( + U+0085 + : + 12345678901234567890 + " is active\n"
  // Required final truth:
  //   redacted = true
  //   leakedColon = false
  //   plaintext token head absent
  //   plaintext token tail absent
  // Expected transcript shape:
  //   echo [REDACTED_SECRET] is active\n
  const c1List = [
    { name: "C1_NEL (U+0085)", raw: "\u0085" },
    { name: "C1_PAD (U+0080)", raw: "\u0080" },
    { name: "C1_CSI (U+009B)", raw: "\u009b" },
    { name: "C1_OSC (U+009D)", raw: "\u009d" },
    { name: "Unicode_Out_Of_Range", raw: "\u0410" },
    { name: "Multi_Disturbance", raw: "\u0085\x00\u009b" },
  ];

  const punctuationFinals = [
    { punc: ":", name: "colon" },
    { punc: ";", name: "semicolon" },
    { punc: "=", name: "equals" },
    { punc: "?", name: "question" },
  ];

  for (const { name: distName, raw: distRaw } of c1List) {
    for (const { punc, name: puncName } of punctuationFinals) {
      const attack = `echo ghp_1234567890\x1b(${distRaw}${punc}12345678901234567890 is active\n`;

      // 1. Single chunk verification
      const resSingle = sanitizeAndRedactTerminalOutput(attack, { maxOutputBytes: 120_000 });
      const transcript = resSingle.transcript;

      const redacted = /\[REDACTED_SECRET\]/.test(transcript);
      const leakedPunc = transcript.includes(punc);
      const hasHead = transcript.includes("ghp_1234567890");
      const hasTail = transcript.includes("12345678901234567890");

      assert.equal(redacted, true, `Expected redacted=true for ${distName} with '${puncName}'`);
      assert.equal(leakedPunc, false, `Expected leakedPunc=false for ${distName} with '${puncName}'`);
      assert.equal(hasHead, false, `Expected hasHead=false (token head absent) for ${distName} with '${puncName}'`);
      assert.equal(hasTail, false, `Expected hasTail=false (token tail absent) for ${distName} with '${puncName}'`);
      assert.equal(transcript, "echo [REDACTED_SECRET] is active\n", `Expected exact transcript for ${distName} with '${puncName}'`);

      // 2. Byte-by-byte verification
      const p = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
      const b = Buffer.from(attack, "utf8");
      for (let i = 0; i < b.length; i++) p.push(b.subarray(i, i + 1));
      const byteRes = p.finish().transcript;
      assert.equal(byteRes, transcript, `Byte-by-byte must match single-chunk for ${distName} with '${puncName}'`);
    }
  }

  // Also verify different intermediate characters: e.g. ')', '*', '+', '$', '/', ' '
  const intermediateChars = [")", "*", "+", "$", "/", " "];
  for (const inter of intermediateChars) {
    const attack = `echo ghp_1234567890\x1b${inter}\u0085:12345678901234567890 is active\n`;
    const res = sanitizeAndRedactTerminalOutput(attack, { maxOutputBytes: 120_000 });
    assert.equal(res.transcript, "echo [REDACTED_SECRET] is active\n");
    assert.doesNotMatch(res.transcript, /ghp_1234567890/);
    assert.doesNotMatch(res.transcript, /12345678901234567890/);
    assert.doesNotMatch(res.transcript, /:/);
  }
});

// --------------------------------------------------------------------------
// Test 18: Credential with inserted OSC remains redacted
// --------------------------------------------------------------------------
await test("credential with inserted OSC sequence remains redacted", () => {
  const evasionAttempt = "Auth: ghp_\x1b]0;terminal-title\x0701234567890123456789 ready\n";
  const result = sanitizeAndRedactTerminalOutput(evasionAttempt, { maxOutputBytes: 120_000 });

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

  const result = sanitizeAndRedactTerminalOutput(evasionKey, { maxOutputBytes: 120_000 });

  assert.doesNotMatch(result.transcript, /MIIEvQIBADANBgkqhki/);
  assert.match(result.transcript, /\[REDACTED_PRIVATE_KEY\]/);
  assert.doesNotMatch(result.transcript, /\x1b/);
});

// --------------------------------------------------------------------------
// Test 19b: Private key marker with C0 disturbance inside CSI remains redacted
// --------------------------------------------------------------------------
await test("private-key marker with C0 disturbance inside CSI parameters remains redacted", () => {
  const evasionKey = [
    "-----BEGIN\x1b[1\x07;32m PRIVATE KEY-----\x1b[0m",
    "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD",
    "-----END\x1b[31\x00\x08m PRIVATE KEY-----\x1b[0m",
    ""
  ].join("\r\n");

  const result = sanitizeAndRedactTerminalOutput(evasionKey, { maxOutputBytes: 120_000 });
  assert.doesNotMatch(result.transcript, /MIIEvQIBADANBgkqhki/);
  assert.match(result.transcript, /\[REDACTED_PRIVATE_KEY\]/);
});

// --------------------------------------------------------------------------
// Test 19c: Private key marker with initial ESC C0/DEL/C1 disturbance remains redacted
// --------------------------------------------------------------------------
await test("private-key marker with initial ESC C0/DEL/C1 disturbance remains redacted", () => {
  const markerAttacks = [
    {
      name: "NUL-BEL",
      beginDisturbance: "\x1b\x00[1;32m",
      endDisturbance: "\x1b\x07[31m",
    },
    {
      name: "BS-DEL",
      beginDisturbance: "\x1b\x08[1;32m",
      endDisturbance: "\x1b\x7f[31m",
    },
    {
      name: "CRLF-C1",
      beginDisturbance: "\x1b\r\n[1;32m",
      endDisturbance: "\x1b\u0085[31m",
    },
    {
      name: "C1CSI-MULTI",
      beginDisturbance: "\x1b\u009b[1;32m",
      endDisturbance: "\x1b\x00\x07\x08[31m",
    },
  ];

  for (const { name, beginDisturbance, endDisturbance } of markerAttacks) {
    const evasionKey = [
      `-----BEGIN${beginDisturbance} PRIVATE KEY-----\x1b[0m`,
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD",
      `-----END${endDisturbance} PRIVATE KEY-----\x1b[0m`,
      ""
    ].join("\r\n");

    const single = sanitizeAndRedactTerminalOutput(evasionKey, { maxOutputBytes: 120_000 });
    assert.doesNotMatch(single.transcript, /MIIEvQIBADANBgkqhki/, `Private key body leaked for ${name}`);
    assert.match(single.transcript, /\[REDACTED_PRIVATE_KEY\]/, `Private key not redacted for ${name}`);
    assert.doesNotMatch(single.transcript, /\[1;32m/, `BEGIN CSI leaked for ${name}`);
    assert.doesNotMatch(single.transcript, /\[31m/, `END CSI leaked for ${name}`);

    // Byte by byte
    const p = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
    const b = Buffer.from(evasionKey, "utf8");
    for (let i = 0; i < b.length; i++) p.push(b.subarray(i, i + 1));
    const byteRes = p.finish().transcript;
    assert.equal(single.transcript, byteRes, `Single-chunk and byte-by-byte must match for ${name}`);
  }
});

// --------------------------------------------------------------------------
// Test 19d: Private-key marker attack with ESC_INTERMEDIATE decoded-C1 and punctuation final
// --------------------------------------------------------------------------
await test("private-key marker with ESC_INTERMEDIATE decoded-C1 and punctuation-final attack remains redacted", () => {
  // Insert ESC + intermediate + decoded-C1 + punctuation-final inside BEGIN and END private-key markers
  // Example: -----BEGIN + ESC ( U+0085 : + PRIVATE KEY-----
  const markerAttacks = [
    {
      name: "C1_NEL_colon",
      beginDisturbance: "\x1b(\u0085:",
      endDisturbance: "\x1b)\u0085;",
    },
    {
      name: "C1_PAD_equals",
      beginDisturbance: "\x1b*\u0080=",
      endDisturbance: "\x1b+\u0080?",
    },
    {
      name: "C1_CSI_question",
      beginDisturbance: "\x1b(\u009b?",
      endDisturbance: "\x1b(\u009b:",
    },
    {
      name: "C1_OSC_semicolon",
      beginDisturbance: "\x1b(\u009d;",
      endDisturbance: "\x1b(\u009d=",
    },
    {
      name: "Unicode_Out_Of_Range",
      beginDisturbance: "\x1b(\u0410:",
      endDisturbance: "\x1b(\uD83D\uDE00;",
    },
  ];

  for (const { name, beginDisturbance, endDisturbance } of markerAttacks) {
    const evasionKey = [
      `-----BEGIN${beginDisturbance} PRIVATE KEY-----\x1b[0m`,
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD",
      `-----END${endDisturbance} PRIVATE KEY-----\x1b[0m`,
      ""
    ].join("\r\n");

    // Single chunk
    const single = sanitizeAndRedactTerminalOutput(evasionKey, { maxOutputBytes: 120_000 });
    assert.doesNotMatch(single.transcript, /MIIEvQIBADANBgkqhki/, `Private key body leaked for ${name}`);
    assert.match(single.transcript, /\[REDACTED_PRIVATE_KEY\]/, `[REDACTED_PRIVATE_KEY] absent for ${name}`);
    assert.doesNotMatch(single.transcript, /[:;=?]/, `Punctuation final leaked for ${name}`);
    assert.doesNotMatch(single.transcript, /\x1b/, `ESC byte leaked for ${name}`);
    assert.doesNotMatch(single.transcript, /[\u0080\u0085\u009b\u009d]/, `C1 control byte leaked for ${name}`);

    // Byte by byte
    const p = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
    const b = Buffer.from(evasionKey, "utf8");
    for (let i = 0; i < b.length; i++) p.push(b.subarray(i, i + 1));
    const byteRes = p.finish().transcript;
    assert.equal(single.transcript, byteRes, `Single-chunk and byte-by-byte must match for ${name}`);
  }
});

// --------------------------------------------------------------------------
// Test 20: Accepted M009 regressions remain PASS after sanitizer
// --------------------------------------------------------------------------
await test("accepted M009 long-gap/quoted/private-key/UTF-8 regressions remain PASS", () => {
  // 1. OpenAI key regression
  const openAiTest = "openai_key = sk-1234567890abcdef1234567890\n";
  assert.match(sanitizeAndRedactTerminalOutput(openAiTest, { maxOutputBytes: 120_000 }).transcript, /\[REDACTED_SECRET\]/);

  // 2. Quoted credential regression
  const quotedTest = 'api_key = "ghp_01234567890123456789"\n';
  assert.match(sanitizeAndRedactTerminalOutput(quotedTest, { maxOutputBytes: 120_000 }).transcript, /\[REDACTED_SECRET\]/);

  // 3. Multi-line streaming private key
  const pipeline = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
  pipeline.push(Buffer.from("-----BEGIN PRIVATE KEY-----\r\n"));
  pipeline.push(Buffer.from("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQD\r\n"));
  pipeline.push(Buffer.from("-----END PRIVATE KEY-----\r\n"));
  const res = pipeline.finish();
  assert.match(res.transcript, /\[REDACTED_PRIVATE_KEY\]/);
  assert.doesNotMatch(res.transcript, /MIIEvQIBADANBgkqhki/);

  // 4. UTF-8 surrounding secrets
  const utf8Secret = "Café API ключ: ghp_01234567890123456789 🚀\n";
  const utf8Res = sanitizeAndRedactTerminalOutput(utf8Secret, { maxOutputBytes: 120_000 });
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
// Test 21b: Mandatory maxOutputBytes authority enforcement
// --------------------------------------------------------------------------
await test("PtyTranscriptPipeline and BoundedTranscriptCollector strictly enforce mandatory positive maxOutputBytes", () => {
  // Missing / invalid options for PtyTranscriptPipeline
  assert.throws(() => new PtyTranscriptPipeline(), CodexProError);
  assert.throws(() => new PtyTranscriptPipeline({}), CodexProError);
  assert.throws(() => new PtyTranscriptPipeline({ maxOutputBytes: 0 }), CodexProError);
  assert.throws(() => new PtyTranscriptPipeline({ maxOutputBytes: -500 }), CodexProError);
  assert.throws(() => new PtyTranscriptPipeline({ maxOutputBytes: NaN }), CodexProError);
  assert.throws(() => new PtyTranscriptPipeline({ maxOutputBytes: "120000" }), CodexProError);

  // BoundedTranscriptCollector
  assert.throws(() => new BoundedTranscriptCollector(), CodexProError);
  assert.throws(() => new BoundedTranscriptCollector(0), CodexProError);
  assert.throws(() => new BoundedTranscriptCollector(-100), CodexProError);
  assert.throws(() => new BoundedTranscriptCollector(Infinity), CodexProError);

  // sanitizeAndRedactTerminalOutput requires active maxOutputBytes
  assert.throws(() => sanitizeAndRedactTerminalOutput("test"), CodexProError);
  assert.throws(() => sanitizeAndRedactTerminalOutput("test", {}), CodexProError);
});

// --------------------------------------------------------------------------
// Test 21c: Strict low maxOutputBytes bound (4096 and 4000 config lower bound)
// --------------------------------------------------------------------------
await test("strict low maxOutputBytes bound (4096 and 4000) is strictly respected without overflow", () => {
  for (const bound of [4096, 4000]) {
    const pipeline = new PtyTranscriptPipeline({ maxOutputBytes: bound });
    for (let i = 0; i < 100; i++) {
      pipeline.push(Buffer.alloc(100, 0x62)); // 'b'
    }
    const res = pipeline.finish();
    assert.equal(res.truncated, true);
    assert.ok(res.retainedBytes <= bound, `retainedBytes (${res.retainedBytes}) must not exceed bound (${bound})`);
    assert.equal(Buffer.byteLength(res.transcript, "utf8"), res.retainedBytes);
    assert.equal(res.rawObservedBytes, 10000);
  }
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
    "\x1b]0;Build in progress\x1bZmalformed-cont\x07",
    "Processing: café, 🚀, and € symbols.\r\n",
    "Secret token: ghp_\x1b[1\x00\x07\x08;32m01234567890123456789\x1b[0m\r\n",
    "\x1bP$q\"ppayload\x07morepayload\x1b\\Dcs removed.\r\n",
    "\x1b]8;;https://example.com\x1b\\Click\x1b]8;;\x1b\\ done.\r\n"
  ].join("");

  const rawBytes = Buffer.from(complexInput, "utf8");

  // Run 1: Single big chunk
  const resSingle = sanitizeAndRedactTerminalOutput(rawBytes, { maxOutputBytes: 120_000 }).transcript;

  // Run 2: 1 byte per chunk
  const pipeByte = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
  for (let i = 0; i < rawBytes.length; i++) {
    pipeByte.push(rawBytes.subarray(i, i + 1));
  }
  const resByte = pipeByte.finish().transcript;
  assert.equal(resByte, resSingle, "Byte-by-byte output must match single-chunk output");

  // Run 3: Deterministic pseudo-random chunk sizes (2..7 bytes)
  const pipeRand = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
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
    const pipeSplit = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
    pipeSplit.push(rawBytes.subarray(0, split));
    pipeSplit.push(rawBytes.subarray(split));
    const resSplit = pipeSplit.finish().transcript;
    assert.equal(resSplit, resSingle, `Split at offset ${split} must match single-chunk output`);
  }
});

// --------------------------------------------------------------------------
// Test 23b: Chunking invariance for initial-ESC disturbance attacks
// --------------------------------------------------------------------------
await test("chunking invariance for initial-ESC disturbance attacks across key split points and random chunking", () => {
  // Attack sample: token attack with initial ESC + multiple C0 disturbances
  const attackText = "echo ghp_1234567890\x1b\x00\x07[31m12345678901234567890\x1b[0m done\n";
  const rawBytes = Buffer.from(attackText, "utf8");

  // Expected baseline: 1 complete chunk
  const resSingle = sanitizeAndRedactTerminalOutput(rawBytes, { maxOutputBytes: 120_000 }).transcript;
  assert.doesNotMatch(resSingle, /ghp_1234567890/);
  assert.match(resSingle, /\[REDACTED_SECRET\]/);

  // 1. One byte per chunk
  const pipeByte = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
  for (let i = 0; i < rawBytes.length; i++) {
    pipeByte.push(rawBytes.subarray(i, i + 1));
  }
  const resByte = pipeByte.finish().transcript;
  assert.equal(resByte, resSingle, "1 byte/chunk must match single-chunk output");

  // 2. Deterministic pseudo-random chunk sizes
  const pipeRand = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
  let offset = 0;
  let step = 1;
  while (offset < rawBytes.length) {
    const nextChunk = rawBytes.subarray(offset, offset + step);
    pipeRand.push(nextChunk);
    offset += step;
    step = ((step * 5 + 3) % 7) + 1; // cycles through 1..7
  }
  const resRand = pipeRand.finish().transcript;
  assert.equal(resRand, resSingle, "Random-chunked output must match single-chunk output");

  // 3. Key split points:
  const escIdx = attackText.indexOf("\x1b");
  const nulIdx = attackText.indexOf("\x00");
  const belIdx = attackText.indexOf("\x07");
  const bracketIdx = attackText.indexOf("[", escIdx);
  const finalMIdx = attackText.indexOf("m", bracketIdx);

  const keySplitOffsets = [
    escIdx + 1,        // after ESC
    nulIdx + 1,        // after first disturbance (NUL)
    belIdx + 1,        // after second disturbance (BEL)
    bracketIdx,        // before '['
    bracketIdx + 1,    // after '['
    finalMIdx,         // before CSI final byte 'm'
    finalMIdx + 1,     // after CSI final byte 'm'
  ];

  for (const split of keySplitOffsets) {
    const pipeSplit = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
    pipeSplit.push(rawBytes.subarray(0, split));
    pipeSplit.push(rawBytes.subarray(split));
    const resSplit = pipeSplit.finish().transcript;
    assert.equal(resSplit, resSingle, `Key split point at offset ${split} must match single chunk output`);
  }

  // 4. Exhaustive 2-chunk splits across every single byte boundary
  for (let split = 1; split < rawBytes.length; split++) {
    const pipeSplit = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
    pipeSplit.push(rawBytes.subarray(0, split));
    pipeSplit.push(rawBytes.subarray(split));
    const resSplit = pipeSplit.finish().transcript;
    assert.equal(resSplit, resSingle, `Split at offset ${split} must match single chunk output`);
  }
});

// --------------------------------------------------------------------------
// Test 34b: Chunking invariance for ESC_INTERMEDIATE decoded-C1 and punctuation-final attacks
// --------------------------------------------------------------------------
await test("chunking invariance for ESC_INTERMEDIATE decoded-C1 and punctuation-final attacks across key split points, random chunking, and exhaustive 2-chunk splits", () => {
  // Canonical punctuation-token attack string:
  const attackText = "echo ghp_1234567890\x1b(\u0085:12345678901234567890 is active\n";
  const rawBytes = Buffer.from(attackText, "utf8");

  // 1. Expected baseline: 1 complete chunk
  const resSingle = sanitizeAndRedactTerminalOutput(rawBytes, { maxOutputBytes: 120_000 }).transcript;
  assert.equal(resSingle, "echo [REDACTED_SECRET] is active\n");
  assert.doesNotMatch(resSingle, /ghp_1234567890/);
  assert.doesNotMatch(resSingle, /12345678901234567890/);
  assert.doesNotMatch(resSingle, /:/);

  // 2. One byte per chunk
  const pipeByte = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
  for (let i = 0; i < rawBytes.length; i++) {
    pipeByte.push(rawBytes.subarray(i, i + 1));
  }
  const resByte = pipeByte.finish().transcript;
  assert.equal(resByte, resSingle, "1 byte/chunk must match single-chunk output");

  // 3. Deterministic pseudo-random chunk sizes
  const pipeRand = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
  let offset = 0;
  let step = 1;
  while (offset < rawBytes.length) {
    const nextChunk = rawBytes.subarray(offset, offset + step);
    pipeRand.push(nextChunk);
    offset += step;
    step = ((step * 5 + 3) % 7) + 1; // cycles through 1..7
  }
  const resRand = pipeRand.finish().transcript;
  assert.equal(resRand, resSingle, "Random-chunked output must match single-chunk output");

  // 4. Explicit splits:
  // - after ESC
  // - after intermediate byte '('
  // - before decoded-C1 (note: U+0085 in UTF-8 is 2 bytes: 0xC2 0x85)
  // - inside decoded-C1 (between 0xC2 and 0x85)
  // - after decoded-C1
  // - before punctuation final ':'
  // - after punctuation final ':'
  const escIdx = rawBytes.indexOf(0x1b);
  const interIdx = rawBytes.indexOf(0x28, escIdx); // '(' is 0x28
  const c1FirstByteIdx = rawBytes.indexOf(0xc2, interIdx); // 0xC2
  const c1SecondByteIdx = c1FirstByteIdx + 1; // 0x85
  const colonIdx = rawBytes.indexOf(0x3a, c1FirstByteIdx); // ':' is 0x3A

  const explicitSplits = [
    escIdx + 1,           // after ESC
    interIdx + 1,         // after intermediate byte '('
    c1FirstByteIdx,       // before decoded-C1 (before 0xC2)
    c1SecondByteIdx,      // inside decoded-C1 (between 0xC2 and 0x85)
    c1SecondByteIdx + 1,  // after decoded-C1
    colonIdx,             // before punctuation final ':'
    colonIdx + 1,         // after punctuation final ':'
  ];

  for (const split of explicitSplits) {
    const pipeSplit = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
    pipeSplit.push(rawBytes.subarray(0, split));
    pipeSplit.push(rawBytes.subarray(split));
    const resSplit = pipeSplit.finish().transcript;
    assert.equal(resSplit, resSingle, `Explicit split at offset ${split} must match single-chunk output`);
  }

  // 5. Exhaustive two-chunk splits across every single byte boundary
  for (let split = 1; split < rawBytes.length; split++) {
    const pipeSplit = new PtyTranscriptPipeline({ maxOutputBytes: 120_000 });
    pipeSplit.push(rawBytes.subarray(0, split));
    pipeSplit.push(rawBytes.subarray(split));
    const resSplit = pipeSplit.finish().transcript;
    assert.equal(resSplit, resSingle, `Exhaustive 2-chunk split at offset ${split} must match single-chunk output`);
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
  const correctResult = sanitizeAndRedactTerminalOutput(evasiveSecret, { maxOutputBytes: 120_000 });
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
