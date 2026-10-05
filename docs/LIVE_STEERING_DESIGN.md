# Live Steering Design (Active-Worker Messaging)

Status: design only. No implementation, no tests, no deploy, no live calls in this leaf.

## 1. Gap (explicit)

- `delegation_followup` question path **refuses** running/queued workers:
  `question_while_running_refused` (`src/delegationStore.ts:843-845`).
- Reply path **fails** unless the run is `needs-input` with an open request:
  `reply_without_open_request` (`src/delegationTools.ts:2379-2381`), plus
  same-session `session_busy` guards (`:2317-2319`, `:2353-2355`).
- Net effect: there is **NO message-active-worker path today**. A live worker
  mid-turn cannot be steered; the caller must wait, cancel/relaunch, or defer.
- Unused native primitive: `codex queue --thread <THREAD> --message <TEXT>`
  (queue a message for an existing session). `codex exec resume
  [SESSION_ID] [PROMPT]` resumes **settled** sessions only — not a steer verb.
  OpenCode v2.0.22: `run --session/-s` is continue-or-create resume only;
  session subcommands are `list|delete|export|import` (no halt/stop/steer verb).
  `claude --resume` continues in background under the same ID (out of scope here).
- Pinned versions: codex-cli 0.159.0, opencode v2.0.22, claude 2.1.289.
  Profiles/agents by real names only (CODEX_* `~/.codex`; opencode
  `~/.config/opencode-v2/opencode/agents`; claude `~/.claude/agents`).

## 2. Smallest engine-native design

- New operation (name TBD, e.g. `delegation_steer`): takes
  `{ run_id, message, steering_key }`. `run_id` resolves to the live
  engine thread/session; `steering_key` is the idempotency key (below).
  Never synthesizes delivery: report exactly what the engine confirms.
- **Codex (preferred):** shell one native call —
  `codex queue --thread <THREAD> --message <TEXT>`, with `<THREAD>` bound from
  the run record's session id. No new prompt construction, no resume, no
  relaunch. If `queue` errors or the thread is unknown, surface the raw
  engine error as `steer_rejected`; never fake acceptance.
- **OpenCode (honest):** no native mid-run steer verb exists in v2.0.22.
  Minimal viable form: probe for a queue-equivalent once; if supported, use it
  behind the same operation; else return explicit `steer_unsupported` naming
  the engine version. Never emulate delivery via a second session, a resume,
  or a cancel+relaunch disguised as steering.
- Semantics (three distinct states, all surfaced truthfully):
  - `accepted` = recorded for the live attempt (store wrote the steering
    record; engine call dispatched or definitively rejected).
  - `queued` = engine confirmed the message is held for the worker's next
    turn (only when the engine itself says so, e.g. `queue` success).
  - `applied` = observed in worker output/session state (a later read shows
    acknowledgement or behavior change). `queued` never implies `applied`.
- Duplicate handling: `steering_key` required per message. Same key + same
  content = benign replay (return original outcome, no second dispatch).
  Same key + changed content = conflict error, no dispatch. Uncertain
  dispatch (timeout / lost reply / ambiguous engine output) **never
  duplicates**: record `steer_unknown`, and a retry must reuse the same key
  and first reconcile against the stored record.

## 3. What this is NOT

- NOT post-completion follow-up (`needs-input` question/reply) — that path
  is unchanged and keeps its current guards.
- NOT cancellation/relaunch steering — `delegation_cancel` stays a separate,
  explicit, idempotent operation; steer must never cancel under the hood.
- NOT the uncertain-cancel / output-artifact bug fixes — separate repair
  scope, no coupling in this design.
- Claude is OUT OF SCOPE for this design (deferred; `--resume` semantics
  untouched).

## 4. Open questions (UNPROVEN — need a live two-session probe)

1. UNPROVEN: does `codex queue` deliver mid-turn (interrupts/injects) or only
   idle-appends at the next turn boundary?
2. UNPROVEN: exact success/error shape of `codex queue` (exit code, stdout
   receipt, unknown-thread error text) for the `queued` vs `steer_rejected`
   mapping.
3. UNPROVEN: whether any opencode v2.0.22 build exposes a queue/steer verb
   beyond the documented subcommands — probe, else `steer_unsupported` stands.
4. UNPROVEN: ordering/flood behavior of multiple queued messages on one live
   Codex thread.
