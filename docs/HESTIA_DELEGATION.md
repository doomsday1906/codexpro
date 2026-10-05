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
| `delegation_cancel` | Idempotent cancel of the exact PID+starttime-verified tree only. Cancel + relaunch is not live steering. |
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
- **Live steering is deferred for this release** on all engines (codex,
  opencode, claude): `delegation_steer` refuses with `steer_deferred`
  (`Live steering is deferred for this release; use delegation_followup
  for amended/ordinary follow-ups or delegation_cancel + relaunch;
  follow-up and cancel/relaunch are not live steering.`). The steering
  implementation remains in Git history; ordinary release use never
  dispatches steering and creates no steering record.
- **Per-run reasoning/variant overrides are unavailable**: there is no
  generic reasoning param; protected Codex `-c` keys that would set
  model/effort/sandbox/approval refuse loudly with
  `protected_config_override` (never silently ignored). Do not add new
  reasoning controls for this release.

## Review discipline

A completed process or green canary NEVER establishes task success.
`read_result` surfaces raw evidence (tails + truncation flags, git-aware or
snapshot workdir diff, test evidence or explicit `unavailable`, Codex
failure classification) for review against the original task and repo
rules. Larger evidence rides the run workdir through the ordinary read
route. Missing engine capability (binary, profile/agent, auth at launch)
leaves that engine INCOMPLETE with an exact blocker — never a substitute.

## Proof

`npm run build` plus `delegation-canary:smoke`,
`delegation-followup:smoke`, `delegation-routing:smoke`,
`delegation-storage:smoke`, `delegation-triengine:smoke`. No live model
calls in smoke (new live paths stay behind real dispatch, which Hestia
drives explicitly).
