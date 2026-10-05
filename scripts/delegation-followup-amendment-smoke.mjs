#!/usr/bin/env node
// Follow-up task-amendment regressions (owner-authorized revision of the
// accepted task, carried by the normal follow-up interface).
//
// GAP: a follow-up carried only payload/questions, so a requirement-changing
// follow-up was indistinguishable from unauthorized expansion (worker-side
// refusal, zero mutation). This leaf adds an optional owner-authorized
// `amended_task` on the follow-up checkpoint: task text ONLY, recorded in
// run history, carried as revised authority in the continuation prompt.
//
// A1-A4 pure unit (no MCP): legacy prompt byte-identity, revised prompt
// shape/guard, typed amendment validation, record/idempotency.
// B0-B6 adapter-level hermetic (labeled shims only, no live model calls):
// installed CLI parity (version only), amendment accepted -> recorded +
// revised prompt with original retained, same-id replay idempotent,
// conflicting content refused, oversize/empty/question-path/canary refusals,
// no-amendment control byte-identical with no record, launch-identity argv
// unchanged, read_result shows original + history.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve('.');
function pathToFileUrl(p) { return `file://${p}`; }

function assert(condition, message) {
  if (!condition) throw new Error(`ASSERT: ${message}`);
}

const Engines = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationEngines.js')));
const Store = await import(pathToFileUrl(path.join(ROOT, 'dist', 'delegationStore.js')));

// ---------- A1: no-amendment prompt is byte-identical to the legacy format ----------
{
  const prompt = Engines.buildFollowupPrompt({
    baseTask: 'Do the thing.',
    isCanary: false,
    requestId: 'q1',
    questions: [{ id: 'qq', question: 'Proceed?' }],
    answerPayload: { answer: 'yes' },
    attemptN: 2
  });
  const legacy = 'Follow-up continuation (attempt 2) for input request q1. '
    + 'Original task: Do the thing. '
    + 'Answered questions: [qq] Proceed? '
    + 'Answers (checkpoint payload JSON): {"answer":"yes"} '
    + 'Stay within the original task\'s scope: create, modify, or delete no file unless the original task explicitly authorized it.';
  assert(prompt === legacy, `no-amendment prompt must be byte-identical to legacy, got ${JSON.stringify(prompt)}`);
  console.log('ok: A1 no-amendment prompt byte-identical to legacy');
}

// ---------- A2: amended prompt carries revised authority, retains original ----------
{
  const revised = 'Do the other thing instead. Touch only docs.';
  const prompt = Engines.buildFollowupPrompt({
    baseTask: 'Do the thing.',
    isCanary: false,
    requestId: 'q1',
    questions: [{ id: 'qq', question: 'Proceed?' }],
    answerPayload: { answer: 'yes' },
    attemptN: 2,
    amendedTask: revised,
    amendmentSeq: 1,
    amendmentCheckpointId: 'a1'
  });
  assert(prompt.includes(`Owner-authorized revision 1 of the accepted task (checkpoint a1): ${revised}`),
    `revised authority label missing: ${JSON.stringify(prompt.slice(0, 300))}`);
  assert(prompt.includes('Original task (superseded for scope purposes, retained for review): Do the thing.'),
    `original must be retained for review: ${JSON.stringify(prompt.slice(0, 500))}`);
  assert(prompt.includes('Stay within the revised task\'s scope: create, modify, or delete no file unless the revised task explicitly authorized it.'),
    `scope guard must reference the revised text: ${JSON.stringify(prompt.slice(-300))}`);
  assert(!prompt.includes('original task\'s scope:'),
    'amended prompt must not carry the original-task guard');
  assert(prompt.includes('Answers (checkpoint payload JSON): {"answer":"yes"}'),
    'answer payload must survive in the amended prompt');
  // Canary input defensively ignores an amendment (canary proof never changes shape).
  const canaryShaped = Engines.buildFollowupPrompt({
    isCanary: true,
    requestId: 'q1',
    questions: [],
    answerPayload: {},
    attemptN: 1,
    amendedTask: revised,
    amendmentSeq: 1,
    amendmentCheckpointId: 'a1'
  });
  assert(!canaryShaped.includes('Owner-authorized revision'),
    'canary prompt must never carry revised authority');
  console.log('ok: A2 amended prompt (revised authority + retained original + revised guard)');
}

// ---------- A3: typed amendment validation (pure) ----------
{
  const realRun = {
    runId: 'run_aaaaaaaaaaaaaaaa', isCanary: false,
    checkpoints: [], appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1,
    inputRequests: [{ id: 'qq1', runId: 'run_aaaaaaaaaaaaaaaa', seq: 0, version: 1, questions: [{ id: 'q', question: 'x?', kind: 'input' }], status: 'open', storedAt: 't' }]
  };
  const reply = (extra) => ({ id: 'a1', run_id: 'run_aaaaaaaaaaaaaaaa', seq: 1, payload: { answer: 'yes' }, input_request_id: 'qq1', ...extra });
  const big = Store.validateCheckpointForRun(realRun, reply({ amended_task: 'x'.repeat(8001) }));
  assert(!big.ok && big.code === 'amendment_too_large', `oversize must be typed, got ${JSON.stringify(big)}`);
  const empty = Store.validateCheckpointForRun(realRun, reply({ amended_task: '   \x00  ' }));
  assert(!empty.ok && empty.code === 'amendment_empty', `empty-after-strip must be typed, got ${JSON.stringify(empty)}`);
  const nonString = Store.validateCheckpointForRun(realRun, reply({ amended_task: 42 }));
  assert(!nonString.ok && nonString.code === 'invalid_amendment', `non-string must be typed, got ${JSON.stringify(nonString)}`);
  const canary = Store.validateCheckpointForRun(
    { ...realRun, isCanary: true },
    reply({ amended_task: 'Revise.' }));
  assert(!canary.ok && canary.code === 'amendment_refused_for_canary', `canary must refuse, got ${JSON.stringify(canary)}`);
  const questionPath = Store.validateCheckpointForRun(realRun,
    { id: 'nq', run_id: 'run_aaaaaaaaaaaaaaaa', seq: 1, payload: {}, questions: [{ id: 'q', question: 'More?' }], amended_task: 'Revise.' });
  assert(!questionPath.ok && questionPath.code === 'amendment_needs_reply', `question-path must refuse, got ${JSON.stringify(questionPath)}`);
  const clean = Store.validateCheckpointForRun(realRun, reply({ amended_task: 'Revise:\x00do Y.' }));
  assert(clean.ok && clean.amendedTask === 'Revise: do Y.' && clean.request?.id === 'qq1',
    `valid amendment must sanitize like launch task, got ${JSON.stringify(clean)}`);
  const plain = Store.validateCheckpointForRun(realRun, reply({}));
  assert(plain.ok && plain.amendedTask === undefined, 'reply without amendment must validate with no revision');
  // Duplicate identity includes the amendment text.
  const storedRun = {
    ...realRun,
    checkpoints: [{ id: 'a1', runId: 'run_aaaaaaaaaaaaaaaa', seq: 1, payload: { answer: 'yes' }, storedAt: 't', applied: true, inputRequestId: 'qq1', amendedTask: 'Revise.' }],
    lastAppliedCheckpointSeq: 1
  };
  const replay = Store.validateCheckpointForRun(storedRun, reply({ amended_task: 'Revise.' }));
  assert(replay.ok && replay.duplicate === true, `same-content replay must be idempotent, got ${JSON.stringify(replay)}`);
  const conflict = Store.validateCheckpointForRun(storedRun, reply({ amended_task: 'Different.' }));
  assert(!conflict.ok && conflict.code === 'duplicate_conflicting', `changed content must conflict, got ${JSON.stringify(conflict)}`);
  const stale = Store.validateCheckpointForRun(storedRun,
    { id: 'a0', run_id: 'run_aaaaaaaaaaaaaaaa', seq: 0, payload: {}, input_request_id: 'qq1', amended_task: 'Revise.' });
  assert(!stale.ok && stale.code === 'stale_checkpoint', `stale seqs still rejected, got ${JSON.stringify(stale)}`);
  console.log('ok: A3 typed validation (oversize/empty/non-string/canary/question-path + replay/conflict/stale)');
}

// ---------- A4: record + idempotency + effective task (pure) ----------
{
  const base = {
    runId: 'run_bbbbbbbbbbbbbbbb', task: 'Do the thing.', isCanary: false,
    state: 'needs-input', attempts: [], checkpoints: [], appliedCheckpointIds: [], lastAppliedCheckpointSeq: -1,
    inputRequests: [{ id: 'qq1', runId: 'run_bbbbbbbbbbbbbbbb', seq: 0, version: 1, questions: [{ id: 'q', question: 'x?', kind: 'input' }], status: 'open', storedAt: 't' }]
  };
  const req = base.inputRequests[0];
  const cp = { id: 'a1', run_id: base.runId, seq: 1, payload: { answer: 'yes' }, input_request_id: 'qq1' };
  const applied = Store.applyCheckpointReply(base, cp, req, 'Do the other thing.');
  assert(applied.run.task === 'Do the thing.', 'launch task must never be rewritten');
  assert(applied.run.taskAmendments?.length === 1
    && applied.run.taskAmendments[0].seq === 1
    && applied.run.taskAmendments[0].checkpointId === 'a1'
    && applied.run.taskAmendments[0].amendedTask === 'Do the other thing.'
    && typeof applied.run.taskAmendments[0].storedAt === 'string',
    `amendment history entry malformed: ${JSON.stringify(applied.run.taskAmendments)}`);
  assert(applied.run.lastAmendedTask === 'Do the other thing.', 'pointer must track the latest revision');
  assert(applied.run.checkpoints[0].amendedTask === 'Do the other thing.', 'applied checkpoint must carry the revision');
  assert(Store.effectiveRunTask(applied.run) === 'Do the other thing.', 'effective task must be the revision');
  assert(Store.effectiveRunTask(base) === 'Do the thing.', 'effective task without amendment must be the launch task');
  const again = Store.applyCheckpointReply(applied.run, cp, applied.request);
  assert(again.run === applied.run && (again.run.taskAmendments?.length ?? 0) === 1,
    'already-applied replay must return the run unchanged with no duplicate entry');
  const plain = Store.applyCheckpointReply(base, { ...cp, id: 'a2' }, req);
  assert((plain.run.taskAmendments ?? []).length === 0 && plain.run.lastAmendedTask === undefined,
    'reply without amendment must record nothing');
  // Question path never records (defense in depth behind validate).
  let threw = null;
  try {
    Store.registerInputRequest(base, { id: 'nq', run_id: base.runId, seq: 9, payload: {}, amended_task: 'Revise.' }, [{ id: 'q', question: 'More?', kind: 'input' }]);
  } catch (error) { threw = error; }
  assert(threw && threw.code === 'amendment_needs_reply', 'question-path registration must refuse a revision');
  console.log('ok: A4 record (history + pointer, history preserved, replay idempotent, question path refuses)');
}

// ---------- B: adapter-level hermetic proof through the MCP handlers ----------
const codexHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-amend-codexhome-'));
await fsp.writeFile(path.join(codexHome, 'CODEX_SCOUT_FAST.config.toml'), [
  'model = "gpt-6-luna"',
  'model_reasoning_effort = "low"',
  'sandbox_mode = "read-only"',
  ''
].join('\n'));
process.env.CODEX_HOME = codexHome;

const clAgents = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-amend-clagents-'));
await fsp.writeFile(path.join(clAgents, 'implementer.md'),
  '---\nname: implementer\nmodel: claude-sonnet-5-5\neffort: high\n---\n\nReal Claude agent fixture.\n');
process.env.CODEXPRO_CLAUDE_AGENTS_DIR = clAgents;

const clProjects = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-amend-clprojects-'));
await fsp.mkdir(path.join(clProjects, 'slug'));
process.env.CODEXPRO_CLAUDE_PROJECTS_DIR = clProjects;

const shimBin = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-amend-shim-'));
const claudeArgvLog = path.join(shimBin, 'claude-argv.log');
await fsp.writeFile(claudeArgvLog, '');
await fsp.writeFile(path.join(shimBin, 'fake-claude.mjs'), [
  `import fs from 'node:fs';`,
  `const args = process.argv.slice(2);`,
  `if (args[0] === '--version') { console.log('2.1.289'); process.exit(0); }`,
  `fs.appendFileSync(process.env.CLAUDE_ARGV_LOG ?? '/dev/null', JSON.stringify(args) + '\\n');`,
  `console.log('{"type":"result"}');`,
  `process.exit(0);`,
  ''
].join('\n'));
await fsp.writeFile(path.join(shimBin, 'claude'),
  `#!/bin/sh\nexec "${process.execPath}" "${path.join(shimBin, 'fake-claude.mjs')}" "$@"\n`);
await fsp.chmod(path.join(shimBin, 'claude'), 0o755);
await fsp.writeFile(path.join(shimBin, 'codex'),
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli 0.159.0"; exit 0; fi\nexit 0\n`);
await fsp.chmod(path.join(shimBin, 'codex'), 0o755);
await fsp.writeFile(path.join(shimBin, 'opencode'),
  `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "opencode v2.0.22"; exit 0; fi\nexit 0\n`);
await fsp.chmod(path.join(shimBin, 'opencode'), 0o755);
process.env.CLAUDE_ARGV_LOG = claudeArgvLog;
process.env.CODEXPRO_CLAUDE_BIN = path.join(shimBin, 'claude');
process.env.CODEXPRO_CODEX_BIN = path.join(shimBin, 'codex');
process.env.CODEXPRO_OPENCODE_BIN = path.join(shimBin, 'opencode');

// B0: installed CLI parity, version only (never a model call).
{
  const codex = spawnSync('codex', ['--version'], { encoding: 'utf8' });
  assert(codex.status === 0 && (codex.stdout + codex.stderr).includes('0.159.0'), 'installed codex-cli must be 0.159.0');
  const oc = spawnSync('opencode', ['--version'], { encoding: 'utf8' });
  assert(oc.status === 0 && (oc.stdout + oc.stderr).includes('2.0.22'), 'installed opencode must be v2.0.22');
  const cl = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  assert(cl.status === 0 && (cl.stdout + cl.stderr).includes('2.1.289'), 'installed claude must be 2.1.289');
  console.log('ok: B0 installed CLI parity (codex-cli 0.159.0, opencode v2.0.22, claude 2.1.289; version only)');
}

const { loadConfig } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'config.js')));
const { createCodexProServer } = await import(pathToFileUrl(path.join(ROOT, 'dist', 'server.js')));
const { Client } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'client', 'index.js')));
const { InMemoryTransport } = await import(pathToFileUrl(path.join(ROOT, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'esm', 'inMemory.js')));

const wsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-amend-mcp-'));
const delegHome = await fsp.mkdtemp(path.join(os.tmpdir(), 'codexpro-amend-deleghome-'));
process.env.CODEXPRO_DELEGATION_DIR = delegHome;
delete process.env.CODEXPRO_DELEGATION_LEGACY_BRIDGE;
const config = loadConfig(['--root', wsRoot]);
const server = createCodexProServer(config);
const [ct, st] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: 'amend-smoke', version: '1' }, { capabilities: {} });
await Promise.all([server.connect(st), client.connect(ct)]);
const call = async (name, args) => client.callTool({ name, arguments: args });
const opened = await call('open_workspace', { root: wsRoot });
assert(!opened.isError, 'open_workspace must succeed');
const wid = opened.structuredContent.workspace_id;

async function waitSettled(runId) {
  for (let i = 0; i < 100; i += 1) {
    const r = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
    if (r.structuredContent.state !== 'running' && r.structuredContent.state !== 'queued') return r;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`ASSERT: run ${runId} never settled`);
}
function claudeArgvLines() {
  return fs.readFileSync(claudeArgvLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
function continuationArgv() {
  const lines = claudeArgvLines();
  const found = lines.filter((argv) => String(argv.at(-1) ?? '').includes('Follow-up continuation'));
  assert(found.length > 0, 'continuation argv must have been captured by the labeled shim');
  return found.at(-1);
}

const ORIGINAL = 'List files. Change nothing.';
const REVISED = 'List files, then summarize README in one line. Change nothing.';

// B1: amendment accepted -> recorded + revised prompt with original retained.
const launched = await call('delegation_launch', {
  workspace_id: wid, engine: 'claude', agent: 'implementer',
  workdir: 'amend-1', task: ORIGINAL,
  delegation_group: 'team-amend', request_id: 'req-amend-1', timeout_ms: 60000
});
assert(!launched.isError, `amend launch failed: ${JSON.stringify(launched.structuredContent)}`);
const runId = launched.structuredContent.run_id;
assert((await waitSettled(runId)).structuredContent.state === 'completed', 'amend run must complete');
const q = await call('delegation_followup', { workspace_id: wid, run_id: runId, checkpoint: { id: 'aq', run_id: runId, seq: 0, payload: {}, questions: [{ id: 'qq', question: 'Proceed?' }] } });
assert(!q.isError && q.structuredContent.state === 'needs-input', 'question must reach needs-input');
const argvBefore = claudeArgvLines().length;
const a = await call('delegation_followup', {
  workspace_id: wid, run_id: runId,
  checkpoint: { id: 'aa', run_id: runId, seq: 1, payload: { answer: 'yes' }, input_request_id: 'aq', amended_task: REVISED }
});
assert(!a.isError && a.structuredContent.executed === true, `amended answer must dispatch: ${JSON.stringify(a.structuredContent)}`);
assert(a.structuredContent.task_revision === 1 && a.structuredContent.amended_task === REVISED,
  `ack must carry the revision: ${JSON.stringify(a.structuredContent)}`);
assert((await waitSettled(runId)).structuredContent.state === 'completed', 'amended continuation must complete');
assert(claudeArgvLines().length === argvBefore + 1, 'exactly one continuation worker must spawn for the amended answer');
{
  const argv = continuationArgv();
  const prompt = String(argv.at(-1));
  assert(prompt.includes(`Owner-authorized revision 1 of the accepted task (checkpoint aa): ${REVISED}`),
    'continuation prompt must carry the revised authority');
  assert(prompt.includes(`Original task (superseded for scope purposes, retained for review): ${ORIGINAL}`),
    'continuation prompt must retain the original for review');
  assert(prompt.includes('Stay within the revised task\'s scope:'),
    'continuation scope guard must reference the revised text');
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(!read.isError, 'read must succeed');
  assert(read.structuredContent.task === ORIGINAL, 'read_result must keep the original task (history never rewritten)');
  assert(read.structuredContent.task_amendments?.length === 1
    && read.structuredContent.task_amendments[0].checkpoint_id === 'aa'
    && read.structuredContent.task_amendments[0].amended_task === REVISED
    && read.structuredContent.task_amendments[0].seq === 1,
    `read_result must surface the amendment history: ${JSON.stringify(read.structuredContent.task_amendments)}`);
  assert(read.structuredContent.effective_task === REVISED, 'read_result must surface the revised pointer');
}
console.log('ok: B1 amendment accepted (recorded history + pointer, revised prompt with original retained)');

// B2: no-amendment control -> legacy prompt byte-identical, no record, same launch identity.
const launched2 = await call('delegation_launch', {
  workspace_id: wid, engine: 'claude', agent: 'implementer',
  workdir: 'amend-2', task: ORIGINAL,
  delegation_group: 'team-amend', request_id: 'req-amend-2', timeout_ms: 60000
});
assert(!launched2.isError, 'control launch failed');
const runId2 = launched2.structuredContent.run_id;
assert((await waitSettled(runId2)).structuredContent.state === 'completed', 'control run must complete');
const q2 = await call('delegation_followup', { workspace_id: wid, run_id: runId2, checkpoint: { id: 'aq', run_id: runId2, seq: 0, payload: {}, questions: [{ id: 'qq', question: 'Proceed?' }] } });
assert(!q2.isError, 'control question must store');
const a2 = await call('delegation_followup', {
  workspace_id: wid, run_id: runId2,
  checkpoint: { id: 'aa', run_id: runId2, seq: 1, payload: { answer: 'yes' }, input_request_id: 'aq' }
});
assert(!a2.isError && a2.structuredContent.executed === true, 'control answer must dispatch');
assert(a2.structuredContent.task_revision === undefined && a2.structuredContent.amended_task === undefined,
  'control ack must carry no revision');
assert((await waitSettled(runId2)).structuredContent.state === 'completed', 'control continuation must complete');
{
  const argv = continuationArgv();
  const prompt = String(argv.at(-1));
  const legacy = `Follow-up continuation (attempt 2) for input request aq. `
    + `Original task: ${ORIGINAL} `
    + `Answered questions: [qq] Proceed? `
    + `Answers (checkpoint payload JSON): {"answer":"yes"} `
    + `Stay within the original task's scope: create, modify, or delete no file unless the original task explicitly authorized it.`;
  assert(prompt === legacy, `control prompt must be byte-identical to legacy, got ${JSON.stringify(prompt)}`);
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: runId2 });
  assert(!read.isError && read.structuredContent.task === ORIGINAL
    && read.structuredContent.task_amendments === undefined
    && read.structuredContent.effective_task === undefined,
    'control read must show the original task with no amendment record');
  // Launch identity: continuation argv minus the prompt is engine/session
  // identity only. The stable session UUID is minted per run (so it differs
  // by construction); everything else must match the amended run's
  // continuation argv minus its (revision-carrying) prompt.
  const norm = (argv) => argv.map((el) => String(el).replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<session-uuid>'));
  const amendedArgv = claudeArgvLines().filter((line) => String(line.at(-1) ?? '').includes('checkpoint aa')).at(-1);
  assert(JSON.stringify(norm(argv.slice(0, -1))) === JSON.stringify(norm(amendedArgv.slice(0, -1))),
    `amendment must not change engine/policy/session argv identity: ${JSON.stringify(argv.slice(0, -1))} vs ${JSON.stringify(amendedArgv.slice(0, -1))}`);
}
console.log('ok: B2 no-amendment control (byte-identical prompt, no record, identical launch-identity argv)');

// B3: same-id replay -> idempotent (no duplicate entry, no second worker).
{
  const before = claudeArgvLines().length;
  const replay = await call('delegation_followup', {
    workspace_id: wid, run_id: runId,
    checkpoint: { id: 'aa', run_id: runId, seq: 1, payload: { answer: 'yes' }, input_request_id: 'aq', amended_task: REVISED }
  });
  assert(!replay.isError && replay.structuredContent.duplicate === true && replay.structuredContent.executed === false,
    `replay must be idempotent, got ${JSON.stringify(replay.structuredContent)}`);
  assert(claudeArgvLines().length === before, 'replay must spawn no second worker');
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: runId });
  assert(read.structuredContent.task_amendments?.length === 1, 'replay must add no duplicate amendment entry');
  console.log('ok: B3 same-id replay idempotent (no duplicate entry, no second worker)');
}

// B4: conflicting amendment content for the same id -> duplicate_conflicting.
{
  const conflict = await call('delegation_followup', {
    workspace_id: wid, run_id: runId,
    checkpoint: { id: 'aa', run_id: runId, seq: 1, payload: { answer: 'yes' }, input_request_id: 'aq', amended_task: 'Something else entirely.' }
  });
  assert(conflict.isError && conflict.structuredContent.error === 'duplicate_conflicting',
    `conflict must refuse, got ${JSON.stringify(conflict.structuredContent)}`);
  console.log('ok: B4 conflicting amendment content refused (duplicate_conflicting)');
}

// B5: oversize / empty / question-path refusals consume nothing.
{
  const launched5 = await call('delegation_launch', {
    workspace_id: wid, engine: 'claude', agent: 'implementer',
    workdir: 'amend-5', task: ORIGINAL,
    delegation_group: 'team-amend', request_id: 'req-amend-5', timeout_ms: 60000
  });
  assert(!launched5.isError, 'refusal-matrix launch failed');
  const runId5 = launched5.structuredContent.run_id;
  assert((await waitSettled(runId5)).structuredContent.state === 'completed', 'refusal-matrix run must complete');
  const qq = await call('delegation_followup', { workspace_id: wid, run_id: runId5, checkpoint: { id: 'rq', run_id: runId5, seq: 0, payload: {}, questions: [{ id: 'qq', question: 'Proceed?' }] } });
  assert(!qq.isError, 'refusal-matrix question must store');
  const big = await call('delegation_followup', {
    workspace_id: wid, run_id: runId5,
    checkpoint: { id: 'rb', run_id: runId5, seq: 1, payload: { answer: 'yes' }, input_request_id: 'rq', amended_task: 'x'.repeat(8001) }
  });
  assert(big.isError && big.structuredContent.error === 'amendment_too_large',
    `oversize must be a typed refusal, got ${JSON.stringify(big.structuredContent)}`);
  const empty = await call('delegation_followup', {
    workspace_id: wid, run_id: runId5,
    checkpoint: { id: 're', run_id: runId5, seq: 1, payload: { answer: 'yes' }, input_request_id: 'rq', amended_task: '   ' }
  });
  assert(empty.isError && empty.structuredContent.error === 'amendment_empty',
    `empty must be a typed refusal, got ${JSON.stringify(empty.structuredContent)}`);
  const onQuestion = await call('delegation_followup', {
    workspace_id: wid, run_id: runId5,
    checkpoint: { id: 'rn', run_id: runId5, seq: 1, payload: {}, questions: [{ id: 'qq2', question: 'More?' }], amended_task: REVISED }
  });
  assert(onQuestion.isError && onQuestion.structuredContent.error === 'amendment_needs_reply',
    `question-path revision must be refused, got ${JSON.stringify(onQuestion.structuredContent)}`);
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: runId5 });
  assert(read.structuredContent.open_input_requests === 1
    && read.structuredContent.task_amendments === undefined
    && (read.structuredContent.attempts?.length ?? 0) === 1,
    'refusals must consume nothing (request open, no record, no attempt)');
  console.log('ok: B5 typed refusals (oversize/empty/question-path consume nothing)');
}

// B6: canary runs refuse amendments (real tasks only).
{
  const canary = await call('delegation_launch', {
    workspace_id: wid, engine: 'codex', profile: 'CODEX_SCOUT_FAST',
    workdir: 'amend-canary', canary: true, request_id: 'req-amend-canary', timeout_ms: 60000
  });
  assert(!canary.isError, `canary launch failed: ${JSON.stringify(canary.structuredContent)}`);
  const canaryId = canary.structuredContent.run_id;
  assert((await waitSettled(canaryId)).structuredContent.state === 'completed', 'canary must complete');
  const cq = await call('delegation_followup', { workspace_id: wid, run_id: canaryId, checkpoint: { id: 'cq', run_id: canaryId, seq: 0, payload: {}, questions: [{ id: 'qq', question: 'Proceed?' }] } });
  assert(!cq.isError, 'canary question must store');
  const refused = await call('delegation_followup', {
    workspace_id: wid, run_id: canaryId,
    checkpoint: { id: 'ca', run_id: canaryId, seq: 1, payload: { answer: 'yes' }, input_request_id: 'cq', amended_task: REVISED }
  });
  assert(refused.isError && refused.structuredContent.error === 'amendment_refused_for_canary',
    `canary amendment must be refused, got ${JSON.stringify(refused.structuredContent)}`);
  const read = await call('delegation_read_result', { workspace_id: wid, run_id: canaryId });
  assert(read.structuredContent.open_input_requests === 1, 'canary request must stay open after refusal');
  console.log('ok: B6 canary amendment refused (real tasks only, nothing consumed)');
}

await client.close();

console.log('\ndelegation-followup-amendment-smoke: PASS (labeled shims only; model calls: none)');
