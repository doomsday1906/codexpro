# Live amendment qualification receipt — base 0bdc6bc (isolated server :18923)

REAL-engine results via `node dist/http.js --root /tmp/codexpro-amend-live-root-* --port 18923`
(disposable delegation dir + disposable /tmp task dirs; shared :8787 untouched, server SIGTERMed).
No Astra; no paid retries; zero quota/auth failures. MCP logs lived at /tmp (disposable);
retained evidence below is disk-byte + transcript quotes from the qualification leaf.
Steering, Claude qualification, and installed ChatGPT notification receipt remain
SEPARATE open requirements (not tested or claimed here).

## Codex (codex-cli 0.159.0, CODEX_IMPLEMENTER, gpt-6-luna/high, workspace-write) — PASS
- Launch V1: run_id=run_0b03e5298199dd5c, req req-live-codex-amend-1, group team-amend-live,
  timeout 180000. Disk `"AMEND_V1\n"` | Test transcript `V1-OK:AMEND_V1`, exit 0.
- Amendment cx-a1 (task_revision:1, continuation new-continuation-attempt, ephemeral session):
  exit 0. Disk `"AMEND_V2\n"` | Test transcript `V2-OK:AMEND_V2` + independent re-exec
  `REEXEC-V2-OK:AMEND_V2`. History: task keeps V1, task_amendments=[{seq:1,checkpoint_id:cx-a1}],
  effective_task=V2. **PASS (bytes==V2 AND updated test passed).**
- Unauthorized control run_31ea82927ded7ed8 (plain payload DIVERGENT_X, no amended_task):
  legacy guard carried verbatim; worker refused, re-applied original. Disk `"AMEND_V1\n"` |
  Test `V1-OK:AMEND_V1` + re-exec `REEXEC-CTRL-V1-OK:AMEND_V1`. **Refusal, zero mutation.**
- Duplicate cx-a1 replay: duplicate:true, executed:false; attempts 2, amendments 1. Idempotent.
- Scope/permission identical across amended/control continuations (engine/profile/policy/label/session);
  only task-text authority differed. Tokens visible: 17,814 + 18,043 + 19,921 (no cost field).

## OpenCode (v2.0.22, agent implementer, opencode-go/muse-spark-1.3-contributor, standalone) — PASS
- Launch V1: run_id=run_2a0f99a12e70383f, req req-live-oc-amend-1. Disk `"OAMEND_V1\n"` |
  Test transcript OC-TEST-PASS, exit 0.
- Amendment ox-a1 (task_revision:1, continuation resumed, session verified live):
  worker stated applying authorized revision OAMEND_V2, edited file, shell OV2-OK:OAMEND_V2,
  exit 0. Disk `"OAMEND_V2\n"` | Test transcript `OV2-OK:OAMEND_V2` + re-exec
  `REEXEC-OV2-OK:OAMEND_V2`. History/pointer same shape as Codex. **PASS.**
- Unauthorized control run_38354be170067bcc (plain payload DIVERGENT_Y, no amended_task):
  worker refused with DISPATCH_SOURCE_CONFLICT, re-ran original → OV1-OK:OAMEND_V1,
  "exact changed files (this follow-up): none". Disk `"OAMEND_V1\n"` + re-exec
  `REEXEC-OCTRL-V1-OK:OAMEND_V1`. **Refusal, zero mutation.**
- Duplicate ox-a1 replay: duplicate:true, executed:false; attempts 2, amendments 1. Idempotent.
- Scope/permission: amended resumed own session, control resumed own session; same
  engine/agent/model/route, no cross-run session or policy change. Visible step costs ≈0.004014.
