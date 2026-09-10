// Direct ordering matrix — response-completion tracker truth table.
//
// TARGET: the exact `createResponseCompletionTracker` shipped in
// `dist/responseCompletion.js` (built from `src/responseCompletion.ts`),
// driven with counting sinks through every terminal-signal ordering.
// No server, no timing: fully deterministic.
//
// Signal key: H = handler success, E = handler error, F = response finish,
// C = response close. Each case asserts the exact sink-call sequence.
//
// Usage: node scripts/http-response-completion-matrix.mjs
import assert from "node:assert/strict";
import { createResponseCompletionTracker } from "../dist/responseCompletion.js";

const results = [];
function check(name, isApp, steps, expectMarks, expectReleases) {
  const marks = [];
  const releases = [];
  const t = createResponseCompletionTracker(isApp, {
    releaseInFlight: () => { releases.push(1); },
    markApplicationCompleted: () => { marks.push(1); }
  });
  for (const s of steps) {
    if (s === "H") t.onHandlerSuccess();
    else if (s === "E") t.onHandlerError();
    else if (s === "F") t.onResponseFinish();
    else if (s === "C") t.onResponseClose();
    else throw new Error(`unknown step ${s}`);
  }
  try {
    assert.deepEqual(marks.length, expectMarks, `${name}: marks=${marks.length} want ${expectMarks}`);
    assert.deepEqual(releases.length, expectReleases, `${name}: releases=${releases.length} want ${expectReleases}`);
    results.push({ case: name, verdict: "PASS" });
    console.log(`  ok ${name} (marks=${marks.length} releases=${releases.length})`);
  } catch (error) {
    results.push({ case: name, verdict: "FAIL", error: error.message });
    console.log(`  FAIL ${name}: ${error.message}`);
  }
}

// Control 1: handler success then finish => one score, one release.
check("H-then-F-app", true, ["H", "F"], 1, 1);
// Control 2: finish then handler success => one score, one release.
check("F-then-H-app", true, ["F", "H"], 1, 1);
// Control 3: close before finish, later handler settlement => zero score, one release.
check("C-then-H-app", true, ["C", "H"], 0, 1);
// Control 4: handler success then close before finish => zero score, one release.
check("H-then-C-app", true, ["H", "C"], 0, 1);
// Control 5a: normal finish then close (H first) => no duplicates.
check("H-F-C-app", true, ["H", "F", "C"], 1, 1);
// Control 5b: normal finish then close (F first) => no duplicates.
check("F-H-C-app", true, ["F", "H", "C"], 1, 1);
// Finish, late close, late handler success: response completed AND handler
// succeeded; the close was after finish so not premature => one score.
check("F-C-H-app", true, ["F", "C", "H"], 1, 1);
// Control 6a: handler exception alone => zero score, one release.
check("E-only-app", true, ["E"], 0, 1);
// Control 6b: handler exception, error-middleware finish, close => zero score, one release.
check("E-F-C-app", true, ["E", "F", "C"], 0, 1);
// Non-application shapes stay weightless through the normal path.
check("H-F-nonapp", false, ["H", "F"], 0, 1);
check("C-H-nonapp", false, ["C", "H"], 0, 1);
// Repeated delivery collapses: double handler/finish/close => still one and one.
check("double-delivery-app", true, ["H", "H", "F", "F", "C", "C"], 1, 1);
check("double-close-app", true, ["C", "C", "H"], 0, 1);
// Handler error defensively beats a stray later success (unreachable via the
// try/catch caller, latched for caller independence).
check("E-then-H-defensive", true, ["E", "H", "F"], 0, 1);
// Held states (control 7 documentation): nothing driven before the boundary.
check("H-only-held", true, ["H"], 0, 0);
check("F-only-held", true, ["F"], 0, 0);
// Finish + close with the handler still pending: held for the handler outcome
// (a later success still completes; a later error still releases).
check("F-C-held", true, ["F", "C"], 0, 0);

const failed = results.filter((r) => r.verdict !== "PASS");
console.log(`MATRIX_SUMMARY: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.log("✗ http response completion matrix FAILED");
  process.exit(1);
}
console.log("✓ http response completion matrix passed");
