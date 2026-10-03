import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const require = createRequire(import.meta.url);
let pythonParser;

function getPythonParser() {
  if (!pythonParser) pythonParser = require('@lezer/python').parser;
  return pythonParser;
}

// Parser-backed provenance is deliberately bounded. A missing, malformed, or
// over-limit parse never grants source fidelity to a credential-looking value.
export const PYTHON_PROVENANCE_MAX_BYTES = 2_000_000;

const PYTHON_PUNCTUATION_TYPES = new Set([
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
  ':',
  ',',
  ';',
  '=',
  '->',
  '|'
]);
const PYTHON_ERROR_NODE_PREFIX = '\u26a0';

function hasPythonErrorNode(nodes) {
  return nodes.some((node) => node.isError || node.type.startsWith(PYTHON_ERROR_NODE_PREFIX));
}

function hasUnexpectedTopLevelIndent(source, nodes) {
  return nodes.some((node) => {
    if (node.parent < 0 || nodes[node.parent]?.type !== 'Script' || node.type === 'Comment') return false;
    const lineStart = Math.max(source.lastIndexOf('\n', node.from - 1), source.lastIndexOf('\r', node.from - 1)) + 1;
    return /^[ \t]+$/u.test(source.slice(lineStart, node.from));
  });
}

function collectTreeNodes(tree) {
  const nodes = [];
  const cursor = tree.cursor();

  const walk = (parent) => {
    const index = nodes.length;
    const node = {
      index,
      parent,
      children: [],
      type: cursor.type.name,
      from: cursor.from,
      to: cursor.to,
      isError: cursor.type.isError === true
    };
    nodes.push(node);
    if (parent >= 0) nodes[parent].children.push(index);
    if (cursor.firstChild()) {
      do walk(index); while (cursor.nextSibling());
      cursor.parent();
    }
  };

  walk(-1);
  return nodes;
}

function directChildren(nodes, parentIndex) {
  return (nodes[parentIndex]?.children ?? []).map((index) => nodes[index]);
}

function meaningfulChildren(nodes, parentIndex) {
  return directChildren(nodes, parentIndex)
    .filter((node) => !PYTHON_PUNCTUATION_TYPES.has(node.type) && !node.isError)
    .sort((left, right) => left.from - right.from || left.to - right.to);
}

function hasParentType(nodes, nodeIndex, expected) {
  const parent = nodes[nodeIndex]?.parent;
  return parent >= 0 && nodes[parent]?.type === expected;
}

function directClassBody(nodes, nodeIndex) {
  const body = nodes[nodeIndex]?.parent;
  if (body < 0 || nodes[body]?.type !== 'Body') return false;
  const classDefinition = nodes[body]?.parent;
  return classDefinition >= 0 && nodes[classDefinition]?.type === 'ClassDefinition';
}

function directScript(nodes, nodeIndex) {
  const parent = nodes[nodeIndex]?.parent;
  return parent >= 0 && nodes[parent]?.type === 'Script';
}

function directVariableBefore(nodes, parentIndex, before) {
  return meaningfulChildren(nodes, parentIndex)
    .filter((child) => child.type === 'VariableName' && child.to <= before)
    .at(-1);
}

function firstAnnotationExpression(nodes, typeDef) {
  return meaningfulChildren(nodes, typeDef.index)[0];
}

function assignmentRhs(nodes, assignment, typeDef) {
  return meaningfulChildren(nodes, assignment.index)
    .filter((child) => child.from >= typeDef.to && child.type !== 'AssignOp')
    .at(0);
}

function isCallKeywordReference(nodes, node, source) {
  if (!node) return false;
  if (node.type === 'VariableName') {
    // Existing hostile fixtures use opaque uppercase/digit identifiers as
    // literal credentials. Do not grant them a new call-reference exception.
    return !/^(?=.*\d)[A-Z0-9_]+$/u.test(source.slice(node.from, node.to));
  }
  if (node.type !== 'MemberExpression') return false;
  const children = directChildren(nodes, node.index);
  return children.length === 3
    && children[1].type === '.'
    && children[2].type === 'PropertyName'
    && isCallKeywordReference(nodes, children[0], source);
}

function collectCallKeywordReferences(nodes, source) {
  const references = [];
  for (const list of nodes) {
    if (list.type !== 'ArgList' || !hasParentType(nodes, list.index, 'CallExpression')) continue;
    const children = directChildren(nodes, list.index)
      .filter((node) => !['(', ')', 'Comment'].includes(node.type));
    for (let index = 0; index < children.length; index += 1) {
      const [name, operator, rhs, next] = children.slice(index, index + 4);
      if (index > 0 && children[index - 1].type !== ',') continue;
      if (name.type !== 'VariableName' || operator?.type !== 'AssignOp') continue;
      if (source.slice(operator.from, operator.to) !== '=') continue;
      if (next && next.type !== ',') continue;
      if (!isCallKeywordReference(nodes, rhs, source)) continue;
      references.push({ nameFrom: name.from, nameTo: name.to, rhsFrom: rhs.from, rhsTo: rhs.to });
    }
  }
  return references;
}

const approvalDigest = (value) => createHash('sha256').update(value).digest('hex');

function collectCallKeywordLiterals(nodes, source) {
  const literals = [];
  for (const list of nodes) {
    if (list.type !== 'ArgList' || !hasParentType(nodes, list.index, 'CallExpression')) continue;
    const callee = directChildren(nodes, nodes[list.parent].index)[0];
    if (!isCallKeywordReference(nodes, callee, source)) continue;
    const children = directChildren(nodes, list.index).filter((node) => !['(', ')', 'Comment'].includes(node.type));
    for (let index = 0; index < children.length; index += 1) {
      const [name, operator, rhs, next] = children.slice(index, index + 4);
      if (index > 0 && children[index - 1].type !== ',') continue;
      if (name.type !== 'VariableName' || operator?.type !== 'AssignOp' || !rhs) continue;
      if (source.slice(operator.from, operator.to) !== '=' || (next && next.type !== ',')) continue;
      if (rhs.type !== 'None' && !(rhs.type === 'String' && rhs.children.length === 0
        && /^["']/u.test(source.slice(rhs.from, rhs.to)))) continue;
      literals.push({ nameFrom: name.from, nameTo: name.to, rhsFrom: rhs.from, rhsTo: rhs.to,
        entry: { keyword_sha256: approvalDigest(source.slice(name.from, name.to)),
          callee_sha256: approvalDigest(source.slice(callee.from, callee.to)),
          value_sha256: approvalDigest(source.slice(rhs.from, rhs.to)) } });
    }
  }
  return literals;
}

export function collectPythonCallKeywordApprovals(source, keywords) {
  const parsed = parsePythonSegment(source);
  if (!parsed.valid) throw new Error('Approval requires complete valid Python source within the parser limit.');
  const allowed = new Set(keywords.map(approvalDigest));
  return [...new Map(parsed.callKeywordLiterals.filter((literal) => allowed.has(literal.entry.keyword_sha256))
    .map((literal) => [JSON.stringify(literal.entry), literal.entry])).values()];
}

function collectSourceFieldSyntax(nodes, source) {
  const suiteConditionNames = [];
  const authorizationAnnotations = [];
  const typeNodes = new Set(['VariableName', 'PropertyName', 'MemberExpression',
    'BinaryExpression', 'BitOp', 'None', 'ParenthesizedExpression', '.', '[', ']', '(', ')', ',']);
  for (const node of nodes) {
    if (node.type === 'Body') {
      const colon = directChildren(nodes, node.index)[0];
      const parent = nodes[node.parent];
      if (colon?.type !== ':' || !['IfStatement', 'WhileStatement', 'ForStatement', 'WithStatement'].includes(parent?.type)) continue;
      const condition = directChildren(nodes, parent.index).filter((child) => child.to <= colon.from).at(-1);
      let tail = condition;
      while (tail?.children.length) tail = directChildren(nodes, tail.index).at(-1);
      if (tail?.type === 'VariableName' && tail.to === condition.to) {
        suiteConditionNames.push({ nameFrom: tail.from, nameTo: tail.to });
      }
      continue;
    }
    if (node.type !== 'TypeDef') continue;
    const parent = nodes[node.parent];
    const parameter = parent?.type === 'ParamList' && hasParentType(nodes, parent.index, 'FunctionDefinition');
    const target = parent?.type === 'AssignStatement' ? meaningfulChildren(nodes, parent.index)[0] : undefined;
    if (!parameter && target?.type !== 'VariableName') continue;
    const name = directVariableBefore(nodes, parent.index, node.from);
    const expression = firstAnnotationExpression(nodes, node);
    if (!name || !expression || source.slice(name.from, name.to).toLowerCase() !== 'authorization') continue;
    const pending = [expression];
    let safeType = true;
    while (pending.length > 0) {
      const current = pending.pop();
      if (!typeNodes.has(current.type) || (current.type === 'BitOp' && source.slice(current.from, current.to) !== '|')) {
        safeType = false;
        break;
      }
      pending.push(...directChildren(nodes, current.index));
    }
    if (!safeType) continue;
    const children = directChildren(nodes, parent.index);
    const typeIndex = children.findIndex((child) => child.index === node.index);
    const operator = children[typeIndex + 1];
    const rhs = operator?.type === 'AssignOp' ? children[typeIndex + 2] : undefined;
    if (operator?.type === 'AssignOp'
      && (source.slice(operator.from, operator.to) !== '=' || !rhs
        || (rhs.type !== 'None' && !isCallKeywordReference(nodes, rhs, source)))) continue;
    authorizationAnnotations.push({ nameFrom: name.from, nameTo: name.to,
      valueFrom: expression.from, safeTo: rhs?.to ?? node.to });
  }
  return { suiteConditionNames, authorizationAnnotations };
}

function parsePythonSegment(source, { completeSource = true } = {}) {
  const text = String(source ?? '');
  if (Buffer.byteLength(text, 'utf8') > PYTHON_PROVENANCE_MAX_BYTES) {
    return { valid: false, reason: 'over-limit', source: text };
  }

  let tree;
  try {
    tree = getPythonParser().parse(text);
  } catch {
    return { valid: false, reason: 'parse-failed', source: text };
  }

  const nodes = collectTreeNodes(tree);
  // Lezer's Python grammar does not reject every CPython indentation error
  // (for example, an indented statement at module scope), so do not let such
  // a tree grant syntax ownership to a credential-looking field.
  if (hasPythonErrorNode(nodes) || (completeSource && hasUnexpectedTopLevelIndent(text, nodes))) {
    return { valid: false, reason: 'parse-error', source: text };
  }

  const annotations = [];
  const aliases = [];
  const functionReturnTypeNames = [];

  for (const node of nodes) {
    if (node.type === 'TypeDef') {
      const parent = nodes[node.parent];
      if (!parent) continue;

      if (parent.type === 'FunctionDefinition') {
        // A simple function return type is followed by the function suite
        // colon. Credential-field matching can mistake that colon and the
        // first token on the next line for a multiline credential field.
        // Record only the exact parser-owned type name; parser errors and the
        // complete-source indentation check return before this metadata exists.
        const expression = firstAnnotationExpression(nodes, node);
        if (expression?.type === 'VariableName') {
          functionReturnTypeNames.push({ nameFrom: expression.from, nameTo: expression.to });
        }
        continue;
      }

      let owner;
      if (parent.type === 'AssignStatement') {
        // Only a simple variable target can donate declaration provenance.
        // Member, tuple, subscript, dictionary, and other assignment targets
        // stay generic/fail-closed even when they contain a TypeDef node.
        const target = meaningfulChildren(nodes, parent.index)[0];
        if (!target || target.type !== 'VariableName' || target.to > node.from) continue;
        if (directScript(nodes, parent.index) || directClassBody(nodes, parent.index)) owner = parent;
      } else if (parent.type === 'ParamList' && hasParentType(nodes, parent.index, 'FunctionDefinition')) {
        const name = directVariableBefore(nodes, parent.index, node.from);
        if (!name) continue;
        owner = parent;
      }
      if (!owner) continue;

      const expression = firstAnnotationExpression(nodes, node);
      if (!expression) continue;
      const name = directVariableBefore(nodes, parent.index, node.from);
      if (!name) continue;
      const assignment = parent.type === 'AssignStatement' ? parent : undefined;
      const rhs = assignment ? assignmentRhs(nodes, assignment, node) : undefined;
      annotations.push({
        nameFrom: name.from,
        nameTo: name.to,
        valueFrom: expression.from,
        rhsFrom: rhs?.from
        // Once the whole source segment is parser-valid and the AST node is a
        // lawful declaration owner, RHS expression shape is not a security
        // classifier. Calls, tuples, strings, generics, and multiline forms
        // all retain their exact source bytes.
      });
      continue;
    }

    if (node.type !== 'TypeDefinition') continue;
    const parent = nodes[node.parent];
    const topLevel = Boolean(parent?.type === 'Script');
    const classNested = Boolean(parent?.type === 'Body' && nodes[parent.parent]?.type === 'ClassDefinition');
    if (!topLevel && !classNested) continue;

    const children = meaningfulChildren(nodes, node.index);
    const aliasName = children.find((child) => child.type === 'VariableName');
    if (!aliasName) continue;
    const typeParameters = children.find((child) => child.type === 'TypeParamList');
    const afterName = typeParameters?.to ?? aliasName.to;
    const rhs = children.find((child) => child.from >= afterName);
    if (!rhs) continue;
    aliases.push({
      nameFrom: aliasName.from,
      nameTo: aliasName.to,
      rhsFrom: rhs.from,
      rhsTo: rhs.to
    });
  }

  return {
    valid: true, source: text, nodes, annotations, aliases, functionReturnTypeNames,
    callKeywordReferences: collectCallKeywordReferences(nodes, text),
    callKeywordLiterals: collectCallKeywordLiterals(nodes, text),
    ...collectSourceFieldSyntax(nodes, text)
  };
}

function splitPhysicalLines(source) {
  const lines = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '\n' && source[index] !== '\r') continue;
    const end = index;
    const separator = source[index] === '\r' && source[index + 1] === '\n' ? '\r\n' : source[index];
    lines.push({ start, end, next: index + separator.length });
    index += separator.length - 1;
    start = index + 1;
  }
  if (start <= source.length) lines.push({ start, end: source.length, next: source.length });
  return lines;
}

function parseHunkHeader(line) {
  const match = String(line ?? '').match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/u);
  if (!match) return undefined;
  return {
    oldRemaining: Number(match[2] ?? 1),
    newRemaining: Number(match[4] ?? 1)
  };
}

function consumeHunkLine(state, line) {
  if (!state) return undefined;
  // Git emits this note without consuming either side of the hunk.
  if (/^\\ No newline at end of file$/u.test(line)) return state;
  // A malformed hunk remains opaque until a non-payload line appears. This
  // keeps header-shaped payload from becoming path metadata while allowing
  // the caller to fail closed for the ambiguous block.
  if (state.invalid) return /^[ +\-]/u.test(line) ? state : undefined;
  const marker = line[0];
  if (marker !== ' ' && marker !== '-' && marker !== '+') return undefined;
  const next = {
    oldRemaining: state.oldRemaining - (marker === '+' ? 0 : 1),
    newRemaining: state.newRemaining - (marker === '-' ? 0 : 1)
  };
  if (next.oldRemaining < 0 || next.newRemaining < 0) return { invalid: true };
  return next.oldRemaining === 0 && next.newRemaining === 0 ? undefined : next;
}

function splitDiffFileRanges(source) {
  const text = String(source ?? '');
  const records = splitPhysicalLines(text);
  if (!records.length) return [{ start: 0, end: text.length, ambiguous: false }];

  const ranges = [];
  let blockStart = 0;
  let blockAmbiguous = false;
  let hunkState;
  let sawHunk = false;
  let completedHunk = false;
  let sawOldHeader = false;
  let sawNewHeader = false;

  const resetBlock = (start) => {
    blockStart = start;
    blockAmbiguous = false;
    hunkState = undefined;
    sawHunk = false;
    completedHunk = false;
    sawOldHeader = false;
    sawNewHeader = false;
  };
  const pushBlock = (end) => {
    ranges.push({ start: blockStart, end, ambiguous: blockAmbiguous || Boolean(hunkState) });
  };

  for (const record of records) {
    const line = text.slice(record.start, record.end);

    // A payload line is always prefixed by a hunk marker, so an unprefixed
    // `diff --git` line is a safe block boundary even when hunk counts are
    // malformed. Any unfinished hunk makes the preceding block ambiguous.
    if (/^diff --git\s/u.test(line)) {
      if (record.start > blockStart) pushBlock(record.start);
      resetBlock(record.start);
      continue;
    }

    if (hunkState) {
      const next = consumeHunkLine(hunkState, line);
      if (next !== undefined || /^[ +\-]/u.test(line) || /^\\ No newline at end of file$/u.test(line)) {
        if (next?.invalid) blockAmbiguous = true;
        hunkState = next;
        if (!hunkState) completedHunk = true;
        continue;
      }
      if (hunkState.invalid || hunkState.oldRemaining !== 0 || hunkState.newRemaining !== 0) blockAmbiguous = true;
      hunkState = undefined;
      completedHunk = true;
    }

    if (/^@@\s/u.test(line)) {
      sawHunk = true;
      hunkState = parseHunkHeader(line) ?? { invalid: true };
      if (hunkState.invalid) blockAmbiguous = true;
      completedHunk = false;
      continue;
    }

    // Minimal unified diffs have no `diff --git` sentinel. Once a complete
    // hunk has ended, a fresh `---` header starts the next file block. Before
    // the first hunk, require an already-seen header pair so repeated or
    // contradictory metadata stays in one block and fails closed.
    if (line.startsWith('--- ')
      && record.start > blockStart
      && (completedHunk || (sawOldHeader && sawNewHeader && !sawHunk))) {
      pushBlock(record.start);
      resetBlock(record.start);
    }
    if (line.startsWith('--- ')) sawOldHeader = true;
    if (line.startsWith('+++ ')) sawNewHeader = true;
  }

  pushBlock(text.length);
  return ranges;
}

function decodeGitQuotedPath(encoded) {
  let decoded = '';
  const octets = [];
  const flushOctets = () => {
    if (!octets.length) return;
    decoded += Buffer.from(octets).toString('utf8');
    octets.length = 0;
  };
  for (let index = 0; index < encoded.length; index += 1) {
    if (encoded[index] !== '\\') {
      flushOctets();
      decoded += encoded[index];
      continue;
    }
    const escaped = encoded[++index];
    if (escaped === undefined) return undefined;
    if (/[0-7]/u.test(escaped)) {
      let octal = escaped;
      for (let count = 0; count < 2 && /[0-7]/u.test(encoded[index + 1] ?? ''); count += 1) {
        octal += encoded[++index];
      }
      octets.push(Number.parseInt(octal, 8));
      continue;
    }
    flushOctets();
    decoded += ({ a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' }[escaped] ?? escaped);
  }
  flushOctets();
  return decoded;
}

function parseDiffPathLine(rawPath, stripPrefix = false) {
  let value = String(rawPath ?? '').split('\t')[0]?.trim() ?? '';
  if (!value) return { valid: false, known: true, present: false, path: undefined };
  if (value === '/dev/null') return { valid: true, known: true, present: false, path: undefined };
  if (value.startsWith('"')) {
    if (!value.endsWith('"') || value.length < 2) return { valid: false, known: true, present: false, path: undefined };
    value = decodeGitQuotedPath(value.slice(1, -1));
    if (value === undefined) return { valid: false, known: true, present: false, path: undefined };
  }
  value = value.replaceAll('\\', '/');
  // Unified headers are consumed by Git with its default -p1 behavior. Strip
  // exactly one relative component regardless of its name (a/, b/, old/,
  // new/, etc.), but never reinterpret absolute POSIX or Windows paths.
  const absolute = value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:\//u.test(value);
  if (stripPrefix && !absolute) {
    const slash = value.indexOf('/');
    if (slash >= 0) value = value.slice(slash + 1);
  }
  return value
    ? { valid: true, known: true, present: true, path: value }
    : { valid: false, known: true, present: false, path: undefined };
}

function sideMetadata(lines, side) {
  const values = [];
  let invalid = false;
  for (const line of lines) {
    const match = line.match(new RegExp(`^(?:rename|copy) ${side === 'old' ? 'from' : 'to'}\\s(.*)$`, 'u'));
    if (!match) continue;
    const parsed = parseDiffPathLine(match[1]);
    if (!parsed.valid) invalid = true;
    else values.push(parsed);
  }
  return { values, invalid };
}

function resolveDiffSide(header, metadata) {
  const metadataPaths = new Set(metadata.values.filter((entry) => entry.present).map((entry) => entry.path));
  const metadataAbsent = metadata.values.some((entry) => !entry.present);
  let valid = !metadata.invalid && metadataPaths.size <= 1 && !(metadataAbsent && metadataPaths.size > 0);
  if (header) {
    if (!header.valid) valid = false;
    if (header.present !== (metadata.values.length === 0 ? header.present : !metadataAbsent)) valid = false;
    if (header.present && metadataPaths.size > 0 && !metadataPaths.has(header.path)) valid = false;
    return {
      valid,
      known: true,
      present: header.present,
      path: valid && header.present ? header.path : undefined
    };
  }
  if (metadata.values.length === 0) return { valid: true, known: false, present: false, path: undefined };
  const first = metadata.values[0];
  return {
    valid,
    known: true,
    present: first.present,
    path: valid && first.present ? first.path : undefined
  };
}

// Resolve both sides from the actual unified-diff headers. Rename/copy
// records corroborate those headers (or provide a bounded fallback when a
// header is absent); a contradiction disables only the affected side.
export function extractDiffSidePaths(source) {
  const lines = String(source ?? '').split(/\r?\n/u);
  const firstHunk = lines.findIndex((line) => /^@@\s/u.test(line));
  // Only the pre-hunk file-header region can establish side identity. A
  // Python payload may itself begin with `--- ` or `+++ `; those lines must
  // never become extra headers or contradict the actual ordered pair.
  const headerRegion = lines.slice(0, firstHunk >= 0 ? firstHunk : lines.length);
  const oldHeaderEntries = headerRegion
    .flatMap((line, index) => line.startsWith('--- ') ? [{ index, parsed: parseDiffPathLine(line.slice(4), true) }] : []);
  const newHeaderEntries = headerRegion
    .flatMap((line, index) => line.startsWith('+++ ') ? [{ index, parsed: parseDiffPathLine(line.slice(4), true) }] : []);
  const oldHeader = oldHeaderEntries.length === 1 ? oldHeaderEntries[0].parsed : undefined;
  const newHeader = newHeaderEntries.length === 1 ? newHeaderEntries[0].parsed : undefined;
  const headerOrderContradiction = oldHeaderEntries.length === 1
    && newHeaderEntries.length === 1
    && oldHeaderEntries[0].index >= newHeaderEntries[0].index;
  const oldHeaderContradiction = oldHeaderEntries.length > 1 || headerOrderContradiction;
  const newHeaderContradiction = newHeaderEntries.length > 1 || headerOrderContradiction;
  const oldMetadata = sideMetadata(headerRegion, 'old');
  const newMetadata = sideMetadata(headerRegion, 'new');
  const old = resolveDiffSide(oldHeaderContradiction ? { valid: false, known: true, present: false, path: undefined } : oldHeader, oldMetadata);
  const next = resolveDiffSide(newHeaderContradiction ? { valid: false, known: true, present: false, path: undefined } : newHeader, newMetadata);
  return {
    oldPath: old.path,
    newPath: next.path,
    oldValid: old.valid,
    newValid: next.valid,
    oldKnown: old.known,
    newKnown: next.known,
    oldPresent: old.present,
    newPresent: next.present
  };
}

function orderedUniquePaths(paths) {
  const seen = new Set();
  const output = [];
  for (const value of paths) {
    if (typeof value !== 'string' || !value || seen.has(value)) continue;
    seen.add(value);
    output.push(value);
  }
  return output;
}

// Canonical hunk-aware unified-diff records. `source` is an exact contiguous
// slice of the input; `paths` contains only both-side-validated, present
// paths, in old/new order, with deterministic dedupe. A block with missing,
// contradictory, or ambiguous metadata exposes no discovery paths.
export function extractDiffFileBlocks(source) {
  const text = String(source ?? '');
  return splitDiffFileRanges(text).map((range) => {
    const block = text.slice(range.start, range.end);
    const sidePaths = extractDiffSidePaths(block);
    const pathDiscoveryValid = !range.ambiguous
      && sidePaths.oldKnown
      && sidePaths.newKnown
      && sidePaths.oldValid
      && sidePaths.newValid
      && (sidePaths.oldPresent || sidePaths.newPresent);
    const paths = pathDiscoveryValid
      ? orderedUniquePaths([
        sidePaths.oldPresent ? sidePaths.oldPath : undefined,
        sidePaths.newPresent ? sidePaths.newPath : undefined
      ])
      : [];
    return {
      source: block,
      start: range.start,
      end: range.end,
      ambiguous: range.ambiguous,
      ...sidePaths,
      pathDiscoveryValid,
      paths
    };
  });
}

function isDiffHeader(line) {
  return /^(?:diff --git\s|---\s|\+\+\+\s|index\s|new file mode\s|old file mode\s|deleted file mode\s|similarity index\s|rename from\s|rename to\s|copy from\s|copy to\s|Binary files\s)/u.test(line);
}

function createDiffSide(source, lineRecords, side, language) {
  const chars = [];
  const originalOffsets = [];
  const originalToVirtual = new Map();
  for (const record of lineRecords) {
    const marker = source[record.start];
    const include = marker === ' ' || (side === 'old' ? marker === '-' : marker === '+');
    if (!include) continue;
    const contentStart = record.start + 1;
    for (let offset = contentStart; offset < record.end; offset += 1) {
      originalToVirtual.set(offset, chars.length);
      originalOffsets.push(offset);
      chars.push(source[offset]);
    }
    chars.push('\n');
    originalOffsets.push(-1);
  }
  return {
    source: chars.join(''),
    originalOffsets,
    originalToVirtual,
    language,
    // Non-Python and absent/ambiguous sides deliberately never reach the
    // parser. Their offsets remain available so every mapped side must still
    // agree before a credential receives Python source fidelity.
    // Unified-diff hunks are partial programs and may begin inside a nested
    // body. The final resulting file is checked as complete source before a
    // write, so module-scope indentation validation belongs to identity parses.
    parse: language === 'python' ? parsePythonSegment(chars.join(''), { completeSource: false }) : undefined
  };
}

function buildDiffSegments(source, options = {}, rangeStart = 0, rangeEnd = source.length) {
  const lines = splitPhysicalLines(source)
    .filter((record) => record.start >= rangeStart && record.start < rangeEnd);
  const segments = [];
  let hunkLines = [];
  let inHunk = false;

  const flush = () => {
    if (hunkLines.length === 0) return;
    const oldSide = createDiffSide(source, hunkLines, 'old', options.oldLanguage);
    const newSide = createDiffSide(source, hunkLines, 'new', options.newLanguage);
    segments.push({ lines: hunkLines, sides: [oldSide, newSide] });
    hunkLines = [];
  };

  for (const record of lines) {
    const line = source.slice(record.start, record.end);
    if (/^@@\s/u.test(line)) {
      flush();
      inHunk = true;
      continue;
    }
    // Once a hunk is active, every line with a unified-diff marker is payload,
    // even when its content begins with `--- ` or `+++ `. Only a non-payload
    // line can terminate the hunk and establish the next file block.
    if (inHunk && /^[ +\-]/u.test(line)) {
      hunkLines.push(record);
      continue;
    }
    if (isDiffHeader(line)) {
      flush();
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
  }
  flush();
  return segments;
}

function isUnifiedDiff(source) {
  return /^(?:diff --git\s|---\s|\+\+\+\s|@@\s)/mu.test(source)
    && source.split(/\r?\n/u).some((line) => /^@@\s/u.test(line));
}

function identitySegment(source) {
  const originalToVirtual = new Map();
  const originalOffsets = [];
  for (let index = 0; index < source.length; index += 1) {
    originalToVirtual.set(index, index);
    originalOffsets.push(index);
  }
  return { source, originalOffsets, originalToVirtual, parse: parsePythonSegment(source) };
}

export function createPythonProvenance(source, options = {}) {
  const text = String(source ?? '');
  if (Buffer.byteLength(text, 'utf8') > PYTHON_PROVENANCE_MAX_BYTES) {
    return { available: false, reason: 'over-limit', segments: [] };
  }
  if (isUnifiedDiff(text)) {
    const blocks = extractDiffFileBlocks(text);
    const callback = typeof options?.languageForPath === 'function' ? options.languageForPath : undefined;
    const defaultLanguageForPath = (filePath) => /\.(?:py|pyi|pyw)$/iu.test(String(filePath ?? '')) ? 'python' : undefined;
    const resolveLanguage = (side, path, present, pathDiscoveryValid) => {
      // `pathDiscoveryValid` is the single block-level authority. A side
      // cannot retain parser provenance when any metadata or hunk in the
      // containing block is contradictory, even if that side looks valid in
      // isolation.
      if (!pathDiscoveryValid) return undefined;
      const optionName = side === 'old' ? 'oldLanguage' : 'newLanguage';
      if (Object.prototype.hasOwnProperty.call(options, optionName)) {
        return options[optionName] === 'python' && present ? 'python' : undefined;
      }
      if (callback) {
        let candidate;
        try {
          candidate = callback(path);
        } catch {
          candidate = undefined;
        }
        return candidate === 'python' && present ? 'python' : undefined;
      }
      if (options?.language === 'python') {
        return present ? defaultLanguageForPath(path) : undefined;
      }
      return undefined;
    };
    const segments = [];
    let hasPythonSide = false;
    for (const block of blocks) {
      const oldLanguage = resolveLanguage('old', block.oldPath, block.oldPresent, block.pathDiscoveryValid);
      const newLanguage = resolveLanguage('new', block.newPath, block.newPresent, block.pathDiscoveryValid);
      if (oldLanguage === 'python' || newLanguage === 'python') hasPythonSide = true;
      segments.push(...buildDiffSegments(text, { oldLanguage, newLanguage }, block.start, block.end));
    }
    return {
      available: segments.length > 0 && hasPythonSide,
      reason: segments.length === 0 ? 'no-hunks' : hasPythonSide ? undefined : 'untrusted-language',
      segments
    };
  }
  if (options?.language !== 'python') {
    return { available: false, reason: 'untrusted-language', segments: [] };
  }
  return { available: true, reason: undefined, segments: [identitySegment(text)] };
}

function offsetInRange(offset, from, to) {
  return Number.isInteger(from) && Number.isInteger(to) && offset >= from && offset < to;
}

function declarationOwnerOffset(source, offset, from, to, allowTypePrefix = false) {
  if (offsetInRange(offset, from, to)) return true;
  if (!Number.isInteger(offset) || !Number.isInteger(from) || offset > from) return false;
  // Typed-declaration matches may begin at the preceding newline/indentation
  // rather than the identifier itself. Do not admit any later bytes before the
  // identifier: a dict key or call keyword inside the RHS is not the owner.
  const prefix = String(source ?? '').slice(offset, from);
  return allowTypePrefix
    ? /^[ \t\r\n]*(?:type[ \t]+)?[ \t\r\n]*$/u.test(prefix)
    : /^[ \t\r\n]*$/u.test(prefix);
}

function querySegment(segment, originalOffset, valueStart) {
  const offset = segment.originalToVirtual.get(originalOffset);
  const value = segment.originalToVirtual.get(valueStart);
  if (!Number.isInteger(offset) || !Number.isInteger(value) || !segment.parse?.valid) return false;

  for (const annotation of segment.parse.annotations ?? []) {
    const valueIsAnnotationRoot = value === annotation.valueFrom;
    const valueIsRhsRoot = Number.isInteger(annotation.rhsFrom) && value === annotation.rhsFrom;
    if (declarationOwnerOffset(segment.source, offset, annotation.nameFrom, annotation.nameTo)) {
      // A candidate must begin at the declaration's annotation/RHS root. A
      // nested dict key or call keyword can sit inside the same AST range but
      // is not the declaration-owned value.
      if (valueIsAnnotationRoot || valueIsRhsRoot) return true;
    }
  }
  for (const alias of segment.parse.aliases ?? []) {
    if (declarationOwnerOffset(segment.source, offset, alias.nameFrom, alias.nameTo, true)
      && offsetInRange(value, alias.rhsFrom, alias.rhsTo)) return true;
  }
  return false;
}

function queryFunctionReturnTypeName(segment, originalStart, originalEnd) {
  const start = segment.originalToVirtual.get(originalStart);
  const last = originalEnd > originalStart
    ? segment.originalToVirtual.get(originalEnd - 1)
    : undefined;
  if (!Number.isInteger(start) || !Number.isInteger(last) || !segment.parse?.valid) return false;
  const end = last + 1;
  return (segment.parse.functionReturnTypeNames ?? []).some(
    (name) => start === name.nameFrom && end === name.nameTo
  );
}

export function isPythonFunctionReturnTypeName({ provenance, offset, end }) {
  if (!provenance?.available || !Number.isInteger(offset) || !Number.isInteger(end) || end <= offset) return false;
  const matches = [];
  for (const segment of provenance.segments ?? []) {
    for (const side of segment.sides ?? [segment]) {
      if (side.originalToVirtual.has(offset) && side.originalToVirtual.has(end - 1)) {
        matches.push(queryFunctionReturnTypeName(side, offset, end));
      }
    }
  }
  // Diff context shared by multiple sides grants this narrow syntax exception
  // only when every mapped Python parse agrees on the same return type name.
  return matches.length > 0 && matches.every(Boolean);
}

export function ownsPythonCredential({ provenance, offset, valueStart }) {
  if (!provenance?.available) return false;
  const matches = [];
  for (const segment of provenance.segments ?? []) {
    for (const side of segment.sides ?? [segment]) {
      if (side.originalToVirtual.has(offset) && side.originalToVirtual.has(valueStart)) {
        matches.push(querySegment(side, offset, valueStart));
      }
    }
  }
  // A shared context line can map to both sides of a diff. Every mapped parse
  // must agree before provenance is granted to avoid a recovery side donating
  // authority to a lawful-looking candidate.
  return matches.length > 0 && matches.every(Boolean);
}

export function ownsPythonCallKeywordReference({ provenance, nameStart, nameEnd, valueStart, valueEnd }) {
  if (!provenance?.available
    || ![nameStart, nameEnd, valueStart, valueEnd].every(Number.isInteger)
    || nameEnd <= nameStart || valueEnd <= valueStart) return false;
  const matches = [];
  for (const segment of provenance.segments ?? []) {
    for (const side of segment.sides ?? [segment]) {
      if (!side.originalToVirtual.has(nameStart)) continue;
      const start = side.originalToVirtual.get(nameStart);
      const nameLast = side.originalToVirtual.get(nameEnd - 1);
      const rhsStart = side.originalToVirtual.get(valueStart);
      const rhsLast = side.originalToVirtual.get(valueEnd - 1);
      matches.push(Boolean(side.parse?.valid
        && Number.isInteger(nameLast) && Number.isInteger(rhsStart) && Number.isInteger(rhsLast)
        && (side.parse.callKeywordReferences ?? []).some((reference) =>
          start === reference.nameFrom && nameLast + 1 === reference.nameTo
          && rhsStart === reference.rhsFrom && rhsLast + 1 === reference.rhsTo)));
    }
  }
  // Missing endpoints and invalid/non-Python mapped sides veto this exception.
  return matches.length > 0 && matches.every(Boolean);
}

export function ownsApprovedPythonCallKeyword({ provenance, entries, nameStart, nameEnd, valueStart, valueEnd }) {
  if (!provenance?.available || !Array.isArray(entries) || entries.length === 0
    || ![nameStart, nameEnd, valueStart, valueEnd].every(Number.isInteger)
    || nameEnd <= nameStart || valueEnd <= valueStart) return false;
  const matches = [];
  for (const segment of provenance.segments ?? []) {
    for (const side of segment.sides ?? [segment]) {
      if (!side.originalToVirtual.has(nameStart)) continue;
      const start = side.originalToVirtual.get(nameStart), nameLast = side.originalToVirtual.get(nameEnd - 1);
      const rhsStart = side.originalToVirtual.get(valueStart), rhsLast = side.originalToVirtual.get(valueEnd - 1);
      matches.push(Boolean(side.parse?.valid && Number.isInteger(nameLast) && Number.isInteger(rhsStart) && Number.isInteger(rhsLast)
        && (side.parse.callKeywordLiterals ?? []).some((literal) =>
          start === literal.nameFrom && nameLast + 1 === literal.nameTo
          && rhsStart === literal.rhsFrom && rhsLast + 1 === literal.rhsTo
          && entries.some((entry) => entry.keyword_sha256 === literal.entry.keyword_sha256
            && entry.callee_sha256 === literal.entry.callee_sha256 && entry.value_sha256 === literal.entry.value_sha256))));
    }
  }
  return matches.length > 0 && matches.every(Boolean);
}

export function isPythonSuiteConditionName({ provenance, offset, end }) {
  if (!provenance?.available || !Number.isInteger(offset) || !Number.isInteger(end) || end <= offset) return false;
  const matches = [];
  for (const segment of provenance.segments ?? []) {
    for (const side of segment.sides ?? [segment]) {
      if (!side.originalToVirtual.has(offset)) continue;
      const start = side.originalToVirtual.get(offset);
      const last = side.originalToVirtual.get(end - 1);
      matches.push(Boolean(side.parse?.valid && Number.isInteger(last)
        && (side.parse.suiteConditionNames ?? []).some((name) => start === name.nameFrom && last + 1 === name.nameTo)));
    }
  }
  return matches.length > 0 && matches.every(Boolean);
}

export function pythonAuthorizationAnnotationEnd({ provenance, nameStart, nameEnd, valueStart }) {
  if (!provenance?.available || ![nameStart, nameEnd, valueStart].every(Number.isInteger) || nameEnd <= nameStart) return undefined;
  const ends = [];
  for (const segment of provenance.segments ?? []) {
    for (const side of segment.sides ?? [segment]) {
      if (!side.originalToVirtual.has(nameStart)) continue;
      const start = side.originalToVirtual.get(nameStart);
      const nameLast = side.originalToVirtual.get(nameEnd - 1);
      const value = side.originalToVirtual.get(valueStart);
      const owner = side.parse?.valid && Number.isInteger(nameLast) && Number.isInteger(value)
        ? (side.parse.authorizationAnnotations ?? []).find((entry) =>
          start === entry.nameFrom && nameLast + 1 === entry.nameTo && value === entry.valueFrom)
        : undefined;
      const last = owner ? side.originalOffsets[owner.safeTo - 1] : undefined;
      ends.push(Number.isInteger(last) && last >= 0 ? last + 1 : undefined);
    }
  }
  return ends.length > 0 && Number.isInteger(ends[0]) && ends.every((end) => end === ends[0]) ? ends[0] : undefined;
}
