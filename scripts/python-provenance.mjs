import { createRequire } from 'node:module';

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

function parsePythonSegment(source) {
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
  if (hasPythonErrorNode(nodes)) {
    return { valid: false, reason: 'parse-error', source: text };
  }

  const annotations = [];
  const aliases = [];

  for (const node of nodes) {
    if (node.type === 'TypeDef') {
      const parent = nodes[node.parent];
      if (!parent) continue;

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

  return { valid: true, source: text, nodes, annotations, aliases };
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

function isDiffHeader(line) {
  return /^(?:diff --git\s|---\s|\+\+\+\s|index\s|new file mode\s|old file mode\s|deleted file mode\s|similarity index\s|rename from\s|rename to\s|copy from\s|copy to\s|Binary files\s)/u.test(line);
}

function createDiffSide(source, lineRecords, side) {
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
    parse: undefined
  };
}

function buildDiffSegments(source) {
  const lines = splitPhysicalLines(source);
  const segments = [];
  let hunkLines = [];
  let inHunk = false;

  const flush = () => {
    if (hunkLines.length === 0) return;
    const oldSide = createDiffSide(source, hunkLines, 'old');
    const newSide = createDiffSide(source, hunkLines, 'new');
    oldSide.parse = parsePythonSegment(oldSide.source);
    newSide.parse = parsePythonSegment(newSide.source);
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
    if (isDiffHeader(line)) {
      flush();
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    if (/^[ +\-]/u.test(line)) hunkLines.push(record);
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
  if (options?.language !== 'python') {
    return { available: false, reason: 'untrusted-language', segments: [] };
  }
  const text = String(source ?? '');
  if (Buffer.byteLength(text, 'utf8') > PYTHON_PROVENANCE_MAX_BYTES) {
    return { available: false, reason: 'over-limit', segments: [] };
  }
  if (isUnifiedDiff(text)) {
    const segments = buildDiffSegments(text);
    return { available: segments.length > 0, reason: segments.length > 0 ? undefined : 'no-hunks', segments };
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
