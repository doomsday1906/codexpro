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

