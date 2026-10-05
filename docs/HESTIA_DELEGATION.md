# Hestia CLI Delegation (RepoConnect)

Durable delegation of bounded tasks to installed CLIs — Codex (`codex
exec`), OpenCode (`opencode run`), Claude (`claude -p`) — through MCP
tools. Each engine uses only its own qualified flags; engines, models,
and permissions are never silently substituted.

## Tools

| Tool | Effect |
|---|---|
| `delegation_preview` | Read-only dry-run: executable, argv shape, profile/agent, model/effort where resolvable, execution policy, workdir. No spawn, no run record. Use before dispatch. |
| `delegation_launch` | Dispatch one run (idempotent `request_id`). Returns the clamped timeout truthfully (`timeout_clamped`). |
| `delegation_read_result` | Authorized read: raw tails + truncation flags, workdir change evidence, test evidence, failure classification, review note. Reading never implies ack. |
| `delegation_followup` | Question path (settled → `needs-input`) and reply path (answer once → one bounded continuation). Follow-up is not live steering. |
| `delegation_cancel` | Idempotent cancel of the exact PID+starttime-verified tree only. Shared project helpers are outside this cleanup scope; it never authorizes workdir retirement. Cancel + relaunch is not live steering. |
| `delegation_closeout` | Explicit OpenCode run retirement and durable central session archival. Workdir release is blocked without atomic engine/project lifecycle coordination; no session, helper, service or directory is deleted. |
| `delegation_read_closeout` | Owner-authorized export pages: default 4000 characters, maximum 12000, continue with `next_offset`. |
| `delegation_steer` | DEFERRED FOR THIS RELEASE: every call refuses with `steer_deferred` on all engines. Use `delegation_followup` for amended/ordinary follow-ups or `delegation_cancel` + relaunch; follow-up and cancel/relaunch are not live steering. |
| `delegation_replay_events` / `events_*` | Wake-up delivery on the one canonical subscription authority (unchanged). |

## Per-engine rules

- **Codex**: legacy canary slice (`canary=true`, group
  `hestia-cli-canary`) keeps the Luna read-only gate. Real tasks verify the
  SELECTED profile (exists, non-Astra model, resolvable sandbox); the
  per-run `execution_policy` (explicit wins over profile) rides `-s`.
  `danger-full-access` is explicit-only, never inherited or auto-escalated.
  `model` is an explicit `-m` override only; `config_overrides` are explicit
  `-c` entries only. `--ephemeral` is kept (session honesty, not capability).
- **OpenCode**: legacy canary keeps host-model equality (`--model` must
  equal the host top-level model; agent optional). Real tasks require the
  SELECTED agent (real name from the agents dir) + an explicit `--model`.
- **Claude**: real tasks only. The agent must exist by real name
  (`~/.claude/agents`). `--model/--effort/--permission-mode/--allowedTools`
  ride argv only when explicitly passed; otherwise the agent/settings
  default governs. Every run carries a stable `--session-id` UUID (minted
  when omitted); `--resume` only after the session file verifies, otherwise
  the same id reuses as first-use creation labeled
  `new-continuation-attempt`. Scoped gitkraken-hooks bypass is explicit
  per-run opt-in only (`disable_gitkraken_hooks=true`, default OFF):
  when true, every claude argv for the run carries per-invocation
  `--settings '{"enabledPlugins":{"gitkraken-hooks@gitkraken":false}}'`
  (inert when the plugin is absent/disabled, zero files touched, never task
  content, never a model/permission substitution); default OFF omits
  `--settings` entirely. The choice is stored on the run and preserved
  across follow-ups; no global `~/.claude` change is ever made.
- **Astra** is never used, never spent, never a fallback, on any engine.
- **Live steering + steerable launches/previews are deferred for this release** on all engines (codex,
  opencode, claude): `delegation_steer` refuses with `steer_deferred`
  (`Live steering is deferred for this release; use delegation_followup
  for amended/ordinary follow-ups or delegation_cancel + relaunch;
  follow-up and cancel/relaunch are not live steering.`).
  `delegation_launch` / `delegation_preview` with `steerable=true` refuse
  pre-state with `steer_deferred` (nothing created, nothing spawned —
  before idempotency lookup, mkdir, run save, per-run server spawn, and
  preview argv; the shared gate stays pure with no mkdir/run/spawn).
  Omit `steerable` for normal execution (codex `--ephemeral`, opencode
  `--standalone`, no adapter-owned server, no `OPENCODE_PASSWORD`); use
  `delegation_followup` or `delegation_cancel` + relaunch with steerable
  omitted (standalone/ephemeral) — follow-up and cancel/relaunch are not
  live steering. The steering implementation remains in Git history;
  ordinary release use never dispatches steering and creates no steering
  record.
- **Per-run reasoning/variant overrides are unavailable**: there is no
  generic reasoning param; protected Codex `-c` keys that would set
  model/effort/sandbox/approval refuse loudly with
  `protected_config_override` (never silently ignored). Do not add new
  reasoning controls for this release.

## Explicit closeout

Keep a completed run resumable until its owner deliberately calls:

```json
{"workspace_id":"<workspace>","run_id":"run_<16 hex>","retire":true}
```

Pass this object to `delegation_closeout` after reviewing the result. The
handler derives terminal state from the persisted run, rejects pending input
or uncertain dispatch, and checks actual attempt identities. Caller-supplied
terminal sets, service PIDs, session IDs or workdir paths are not accepted.
An immutable `retirement.json` in the existing central run artifact directory
seals adapter follow-ups; explicit reuse of that session through this workspace
is refused. Completed turns alone do not create retirement intent. The intent
is independent of mutable run snapshots and remains effective after a lost
reply or process interruption. Export failure leaves the run retired: retry
closeout to finish archival, rather than dispatching another turn.

The supported `opencode session export <recorded id>` output is bounded to
8 MiB, identity-checked, atomically published in a run/owner/session-bound
`session-export.json` envelope containing the exact engine output, fsynced
and read back before publishing a bound archival receipt alongside it
and reporting `exported=true`. A retry re-fsyncs an interrupted publication
before confirming it; file presence alone is never archival confirmation. Failed commands, partial
output, invalid exports, storage failures and preoccupied conflicting artifacts
never authorize deletion. Completed immutable exports replay without another
engine invocation. `delegation_read_result` returns only closeout metadata;
`delegation_read_closeout` supplies bounded pages of the archive. Retired run
records and their archives are retained outside automatic bounded pruning;
there is no new automatic archive cleanup. This adapter closeout route does not
revive a terminal run's disposed private server and reports
`private-server-export-unsupported` for those sessions. The engine CLI itself
supports `session export --server`; exporting private history requires its
owning endpoint and must never fall back to the shared session database.

**Workdir release remains blocked on OpenCode v2.0.22.** Its per-project
CodeGraph helpers belong to the long-lived shared service even when the worker
uses `--standalone`. Helpers survive turn completion and session deletion, and
are reused by concurrent sessions. The installed OpenAPI exposes
`debug.location.evict`, which disposes cached services but allows the next use
to initialize them again, and `experimental.mcp.disconnect`, which removes
shared tools until reconnected. Neither operation offers a documented lease
or atomic exclusion of concurrent project users. `location.reload` rebuilds
every loaded location and affects pending permissions/forms; `worktree.remove`
follows the engine's recorded worktree strategy, rather than releasing an
adapter-owned arbitrary directory. These operations do not authorize automatic
workdir retirement. Neither an empty `session list` nor
cwd/argv/PID evidence can establish exclusive ownership. Closeout therefore
always reports `dir_clear=false`, `cleanup_finished=false`,
`session_deleted=false`, no signalled helpers, and `workdir_release=blocked`.
The engine history, shared service/helpers and directory are preserved. This
receipt is archival evidence only, never permission to delete a directory;
the actual engine/project lifecycle owner must coordinate release. Retirement
blocks subsequent requests for this adapter run; it cannot exclude an already
in-flight dispatch, external clients or other sessions/projects. The export is
a session snapshot, and the engine retains the original history. Closeout
never overwrites mutable run state during concurrent activity.

## Review discipline

A completed process or green canary NEVER establishes task success.
`read_result` surfaces raw evidence (tails + truncation flags, git-aware or
snapshot workdir diff, test evidence or explicit `unavailable`, Codex
failure classification) for review against the original task and repo
rules. Larger evidence rides central run storage through the ordinary artifact
read route. Missing engine capability (binary, profile/agent, auth at launch)
leaves that engine INCOMPLETE with an exact blocker — never a substitute.

## Proof

`npm run build` plus `delegation-canary:smoke`,
`delegation-followup:smoke`, `delegation-routing:smoke`,
`delegation-storage:smoke`, `delegation-triengine:smoke`,
`session-helpers:smoke` (public MCP closeout regressions). No live model
calls in smoke (new live paths stay behind real dispatch, which Hestia
drives explicitly).
