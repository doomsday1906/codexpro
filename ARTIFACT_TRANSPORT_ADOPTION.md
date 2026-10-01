# read_artifact — live adoption + Hestia qualification receipt

Candidate: branch `candidate/repoconnect-generic-artifact-20261001`
(commit hash: see `git log --oneline -1` on that branch; built from `c1144bc0`).

## What it is

Generic workspace file/binary transport. New MCP tool `read_artifact`
(standard + full modes; absent from minimal), implemented in
`src/artifactOps.ts`, registered in `src/server.ts` next to `view_image`.

- Input: `{ workspace_id?, path, max_bytes? }` (`max_bytes` 4096–10_000_000,
  default ≈1 MB from server config).
- Safety: exact workspace binding via `PathGuard` (traversal, symlink-escape,
  and blocked-glob rejection); directories/missing/oversized/changed files
  fail honestly; MIME is sniffed from magic bytes (MP4 `ftyp`, images, PDF,
  ZIP, audio/video containers) with an extension hint fallback, never taken
  from the caller; no execution; no secret broadening beyond existing
  blocked globs. `view_image` and text `read` are unchanged.
- Result: bounded text metadata (`Artifact / Type / Bytes / SHA-256`) plus
  native MCP embedded-resource content
  `{ type: "resource", resource: { uri, mimeType, blob(base64) } }`.
  No base64 is dumped into text/structured JSON.

## Proof (implementation boundary only)

`node scripts/artifact-transport-proof.mjs` → 15/15 PASS through the public
MCP stdio route (`tools/list` + `tools/call`): image regression, exact-byte
binary fixture, `ftyp` sniff, 8 negatives (missing/dir/traversal/symlink/
oversize/wrong-workspace/cross-workspace/malformed), standard-vs-minimal
exposure. Full `node scripts/smoke.mjs` also PASS.

Real retained MP4 through the public action: `video/mp4`, 709090 bytes,
SHA-256 `cb2b8e14…fd4d`, byte-identical to the retained original.

## Live adoption (NOT yet performed — shared production untouched)

Production currently runs installed `codexpro@0.31.0` (same version line as
the candidate base). Adopting is a deliberate, Andrew-owned cutover:

1. From the repo lane: `node scripts/deploy-local.mjs <exact-40-char-candidate-commit>`
   (requires an exact clean source commit; refuses live npm-link coupling).
2. Andrew restarts the shared connector from his own terminal (Ctrl+C, then
   the previous start command — same roots/flags as the running process).
3. Verify: `tools/list` shows `read_artifact`; re-run the proof script
   against the live roots.

## Actual-Hestia qualification (external, after adoption)

- Action: `read_artifact`
- Args: `workspace_id = ws_2b68852c30b5a29792998c30`,
  `path = evidence/threadmark/agent-operations-20260928/player-recording/ui-20260928T183008Z-233acccf-op-8964be82af2441cdb58cc89c471bfff8-video-20260928T183058726-127bccb6.mp4`
- Expected: `mime_type video/mp4`, `bytes 709090`,
  `sha256 cb2b8e14c410be5241be00764c6c4b7cd5f9251e0ddfc72eacf05a6c130fd4d4`,
  content part `{ type: "resource", resource: { mimeType: "video/mp4", blob } }`.

Known boundary, stated not proven: MCP SDK 1.30.0 has image/audio/resource
content types but no video type, so MP4 travels as an embedded-resource blob.
Whether the production ChatGPT connector surfaces that blob as a receivable
file is determined ONLY by actual Hestia invoking the live action — no claim
is made here. Failures there return to this lane for focused repair.
