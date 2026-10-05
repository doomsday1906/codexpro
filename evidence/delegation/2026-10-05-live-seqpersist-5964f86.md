# Live amendment-persistence sequence receipt — base 5964f86 (isolated :18923/:18787-class server)

REAL-engine results via isolated `node dist/http.js` (disposable root/delegation/task
dirs under /tmp; shared :8787 untouched; server SIGTERMed + owned /tmp dirs removed
after). No Astra; zero quota/auth failures; zero retries. Steering, Claude, and
installed ChatGPT notification receipt remain SEPARATE open requirements (untested here).

## Codex (codex-cli, CODEX_IMPLEMENTER, gpt-6-luna/high, workspace-write, ephemeral) — PASS
- Run ID: run_b3c97787d9ab6876 (request req_ce4f342e07aedf5e), group seqproof-leaf,
  workdir /tmp/opencode/seqproof-task-codex/wd (disposed), timeout 600000.
- V1: attempt 1 exit 0. Disk bytes `56 31 0a` (V1\n); bash test_v1.sh → PASS-V1 exit 0
  (worker transcript + independent re-exec).
- Amendment ckpt-amend-v2 (reply to ckpt-q1, task_revision 1, new-continuation-attempt):
  attempt 2 exit 0. Disk bytes `56 32 0a` (V2\n); bash test_v2.sh → PASS-V2 exit 0
  (transcript + re-exec). Amendments: 1, original retained.
- Ordinary follow-up ckpt-ans-2 (reply to ckpt-q2, payload only, NO amended_task):
  attempt 3 exit 0; worker re-read V2 bytes, ran test_v2.sh → PASS-V2, no files changed.
  effective_task==V2, amendments 1, engine/profile/policy unchanged.
- Verbatim replay of ckpt-ans-2: duplicate:true, executed:false; attempts 3, amendments 1.
  No extra worker.
- Tokens visible: attempt-1 transcript 17,722 (no cost field).

## OpenCode (v2.0.22, agent implementer, opencode-go/muse-spark-1.3-contributor, standalone) — PASS
- Run ID: run_759fbd218aa16eb2 (request req_0770f9b3fbf83603), group seqproof-leaf,
  workdir /tmp/opencode/seqproof-task-oc/wd (disposed), timeout 600000,
  session ses_ef3624584ffeDuVxfhPy9cVOTK true-resumed attempts 2-3 (verified live).
- V1: attempt 1 exit 0. Disk `56 31 0a`; test_v1.sh → PASS-V1 (transcript + re-exec).
- Amendment ock-amend-v2 (reply to ock-q1, task_revision 1): attempt 2 exit 0.
  Disk `56 32 0a`; test_v2.sh → PASS-V2 (transcript + re-exec). Amendments: 1.
- Ordinary follow-up ock-ans-2 (reply to ock-q2, NO amended_task): attempt 3 exit 0;
  re-verified `56 32 0a` + PASS-V2, no mutation. effective_task==V2, amendments 1,
  engine/agent/model unchanged.
- Verbatim replay of ock-ans-2: duplicate:true, executed:false; attempts 3, amendments 1.
  No extra worker.
- Visible step usage: input 746 / output 134 / reasoning 529 / cache-read 19057 (partial).

## Verdict: SEQUENCE-PROVEN (both engines)
V1 → authorized V2 (updated test passes) → ordinary follow-up re-verifies V2 with
one amendment, unchanged engine/profile/policy, idempotent replay. Procedural note:
amended_task requires input_request_id (question→needs-input→reply shape); enforced
by existing validation, consistent with the accepted authority model.
