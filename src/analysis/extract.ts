import fsp from "node:fs/promises";
import path from "node:path";
import { parser as pythonParser } from "@lezer/python";
import type { CodexProConfig } from "../config.js";
import { isHiddenRelativePath } from "../fsOps.js";
import type { PathGuard, Workspace } from "../guard.js";
import { redactSensitiveTextPreservingLines, sourceLanguageForPath } from "../redact.js";
import type { AnalysisLanguage, AnalysisSymbol, AnalysisSymbolKind, InventoryFile } from "./types.js";

type Pattern = { regex: RegExp; kind: AnalysisSymbolKind };

const DECLARATIONS: Partial<Record<AnalysisLanguage, Pattern[]>> = {
  typescript: [
    { regex: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { regex: /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { regex: /\b(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, kind: "interface" },
    { regex: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "variable" }
  ],
  javascript: [
    { regex: /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, kind: "function" },
    { regex: /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/, kind: "class" },
    { regex: /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, kind: "variable" }
  ],
  python: [
    { regex: /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, kind: "function" },
    { regex: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" }
  ],
  go: [
    { regex: /^func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, kind: "function" },
    { regex: /^type\s+([A-Za-z_]\w*)\s+/, kind: "type" }
  ],
  rust: [
    { regex: /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, kind: "function" },
    { regex: /^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
    { regex: /^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" },
    { regex: /^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/, kind: "trait" }
  ],
  swift: [
    { regex: /^\s*(?:public\s+|internal\s+|private\s+)?func\s+([A-Za-z_]\w*)/, kind: "function" },
    { regex: /^\s*(?:public\s+|internal\s+|private\s+)?class\s+([A-Za-z_]\w*)/, kind: "class" },
    { regex: /^\s*(?:public\s+|internal\s+|private\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" },
    { regex: /^\s*(?:public\s+|internal\s+|private\s+)?protocol\s+([A-Za-z_]\w*)/, kind: "protocol" }
  ],
  java: [
    { regex: /^\s*(?:public|protected|private)?\s*(?:static\s+)?class\s+([A-Za-z_]\w*)/, kind: "class" },
    { regex: /^\s*(?:public|protected|private)?\s*(?:static\s+)?interface\s+([A-Za-z_]\w*)/, kind: "interface" },
    { regex: /^\s*(?:public|protected|private)?\s*(?:static\s+)?enum\s+([A-Za-z_]\w*)/, kind: "enum" }
  ],
  csharp: [
    { regex: /^\s*(?:public|protected|private|internal)?\s*(?:static\s+)?class\s+([A-Za-z_]\w*)/, kind: "class" },
    { regex: /^\s*(?:public|protected|private|internal)?\s*(?:static\s+)?interface\s+([A-Za-z_]\w*)/, kind: "interface" },
    { regex: /^\s*(?:public|protected|private|internal)?\s*(?:static\s+)?struct\s+([A-Za-z_]\w*)/, kind: "struct" }
  ],
  c: [{ regex: /^\s*[A-Za-z_]\w*(?:\s+[*])?\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/, kind: "function" }],
  cpp: [
    { regex: /^\s*class\s+([A-Za-z_]\w*)/, kind: "class" },
    { regex: /^\s*struct\s+([A-Za-z_]\w*)/, kind: "struct" },
    { regex: /^\s*[A-Za-z_:][\w:<>,*&\s]*\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/, kind: "function" }
  ]
};

const SOURCE_LANGUAGES = new Set<AnalysisLanguage>(["typescript", "javascript", "python", "go", "rust", "swift", "java", "csharp", "c", "cpp"]);

export interface ExtractedFile {
  path: string;
  text: string;
  symbols: AnalysisSymbol[];
  /** Legacy target-only view retained for internal compatibility. */
  imports: string[];
  /** Complete bounded import occurrences with physical source provenance. */
  importRecords?: ExtractedImport[];
}

export interface ExtractedImport {
  target: string;
  line: number;
  text: string;
}

interface ParsedImportStatement {
  specifier: string;
  names?: string[];
}

function splitPythonNames(value: string): string[] {
  const withoutComment = value.replace(/\s+#.*$/u, "").trim();
  const unwrapped = withoutComment.replace(/^\(\s*/u, "").replace(/\s*\)$/u, "").trim();
  if (!unwrapped) return [];
  return unwrapped
    .split(",")
    .map((part) => part.trim().replace(/\s+as\s+[A-Za-z_]\w*$/iu, "").trim())
    .filter((part) => part === "*" || /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u.test(part));
}

function parsePythonImportStatement(statement: string): ParsedImportStatement[] {
  const normalized = statement
    .split(/\r?\n/gu)
    .map((line) => line.replace(/#.*$/u, ""))
    .join(" ")
    .replace(/\\[ \t]*/gu, " ")
    .replace(/[ \t]+/gu, " ")
    .trim();
  const fromMatch = normalized.match(/^from\s+([.\w]+)\s+import(?:\s+([\s\S]*))?$/u);
  if (fromMatch?.[1]) {
    return [{ specifier: fromMatch[1], names: splitPythonNames(fromMatch[2] ?? "") }];
  }
  const importMatch = normalized.match(/^import\s+([\s\S]+)$/u);
  if (!importMatch?.[1]) return [];
  return importMatch[1]
    .replace(/\s+#.*$/u, "")
    .split(",")
    .map((part) => part.trim().replace(/\s+as\s+[A-Za-z_]\w*$/iu, "").trim())
    .filter((part) => /^[.\w]+$/u.test(part))
    .map((specifier) => ({ specifier }));
}

function lineStartsFor(text: string): number[] {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

function lineAtOffset(starts: number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (starts[middle] <= offset) low = middle + 1;
    else high = middle;
  }
  return Math.max(1, low);
}

function pythonImportStatements(text: string): Map<number, ParsedImportStatement[]> {
  const byLine = new Map<number, ParsedImportStatement[]>();
  const starts = lineStartsFor(text);
  try {
    const tree = pythonParser.parse(text);
    const cursor = tree.cursor();
    for (;;) {
      if (cursor.name === "ImportStatement") {
        const line = lineAtOffset(starts, cursor.from);
        const parsed = parsePythonImportStatement(text.slice(cursor.from, cursor.to));
        if (parsed.length > 0) byLine.set(line, [...(byLine.get(line) ?? []), ...parsed]);
      }
      if (!cursor.next(true)) break;
    }
    return byLine;
  } catch {
    // A malformed source file still gets conservative line-level extraction.
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const parsed = parsePythonImportStatement(lines[index]);
      if (parsed.length > 0) byLine.set(index + 1, parsed);
    }
    return byLine;
  }
}

function importSpecifiers(language: AnalysisLanguage, line: string): ParsedImportStatement[] {
  if (language === "typescript" || language === "javascript") {
    const match = line.match(/\b(?:import|export)\b[^"']*?["']([^"']+)["']|\brequire\(\s*["']([^"']+)["']\s*\)/);
    return match?.[1] || match?.[2] ? [{ specifier: match[1] ?? match[2] ?? "" }] : [];
  }
  if (language === "c" || language === "cpp") {
    const match = line.match(/^\s*#include\s*["<]([^">]+)[">]/);
    return match?.[1] ? [{ specifier: match[1] }] : [];
  }
  return [];
}

function safeInventoryPath(candidate: string, files: Set<string>): string | undefined {
  const normalized = path.posix.normalize(candidate);
  if (path.posix.isAbsolute(candidate) || normalized === "." || normalized === ".." || normalized.startsWith("../")) return undefined;
  return files.has(normalized) ? normalized : undefined;
}

function resolvePythonModuleAtBase(base: string, files: Set<string>): string | undefined {
  if (base === "." || base === ".." || base.startsWith("../") || path.posix.isAbsolute(base)) return undefined;
  return [safeInventoryPath(`${base}.py`, files), safeInventoryPath(`${base}/__init__.py`, files)].find(Boolean);
}

function pythonModuleBases(fromPath: string, specifier: string): string[] {
  const dotMatch = specifier.match(/^(\.+)(.*)$/u);
  if (dotMatch) {
    const dotCount = dotMatch[1].length;
    const rest = dotMatch[2];
    let baseDir = path.posix.dirname(fromPath);
    for (let index = 1; index < dotCount; index += 1) {
      if (baseDir === "." || baseDir === ".." || baseDir.startsWith("../")) return [];
      baseDir = path.posix.dirname(baseDir);
    }
    const subPath = rest ? rest.split(".").join("/") : "";
    return [subPath ? path.posix.normalize(path.posix.join(baseDir, subPath)) : baseDir];
  }
  const asPath = specifier.split(".").join("/");
  const bases = [asPath, `src/${asPath}`];
  const parts = fromPath.split("/");
  if (parts.length > 1) bases.push(`${parts[0]}/${asPath}`);
  return bases;
}

function resolvePythonModule(fromPath: string, specifier: string, files: Set<string>): { target: string; base: string } | undefined {
  for (const base of pythonModuleBases(fromPath, specifier)) {
    const target = resolvePythonModuleAtBase(base, files);
    if (target) return { target, base };
  }
  return undefined;
}

function resolvePythonImports(fromPath: string, statement: ParsedImportStatement, files: Set<string>): string[] {
  const resolved = resolvePythonModule(fromPath, statement.specifier, files);
  const names = statement.names ?? [];
  if (names.length === 0 || names.includes("*")) return resolved ? [resolved.target] : [];
  const packageBase = resolved?.target.endsWith("/__init__.py")
    ? resolved.base
    : resolved
      ? undefined
      : pythonModuleBases(fromPath, statement.specifier)[0];
  const targets: string[] = [];
  for (const name of names) {
    const nestedBase = packageBase ? path.posix.normalize(path.posix.join(packageBase, name.split(".").join("/"))) : "";
    const nested = nestedBase ? resolvePythonModuleAtBase(nestedBase, files) : undefined;
    if (nested) targets.push(nested);
    else if (resolved) targets.push(resolved.target);
  }
  return [...new Set(targets)];
}

function resolveInternalImport(fromPath: string, specifier: string, files: Set<string>): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const raw = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  const withoutRuntimeExtension = raw.replace(/\.(js|mjs|cjs)$/, "");
  const candidates = [raw, withoutRuntimeExtension, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".swift", ".java", ".cs", ".c", ".cpp", ".h", ".hpp"].map((ext) => `${withoutRuntimeExtension}${ext}`), ...["index.ts", "index.tsx", "index.js", "index.py"].map((name) => `${withoutRuntimeExtension}/${name}`)];
  return candidates.find((candidate) => files.has(candidate));
}

function resolveInternalImports(fromPath: string, statement: ParsedImportStatement, files: Set<string>, language: AnalysisLanguage): string[] {
  if (language === "python") return resolvePythonImports(fromPath, statement, files);
  const target = resolveInternalImport(fromPath, statement.specifier, files);
  return target ? [target] : [];
}

export async function extractWorkspaceFiles(
  config: CodexProConfig,
  guard: PathGuard,
  workspace: Workspace,
  inventoryFiles: InventoryFile[]
): Promise<{ files: ExtractedFile[]; analyzedFiles: number; scannedBytes: number; truncated: boolean; warnings: string[] }> {
  const fileSet = new Set(inventoryFiles.map((file) => file.path));
  const extracted: ExtractedFile[] = [];
  let scannedBytes = 0;
  let symbolCount = 0;
  let sourceBudgetReached = false;
  let symbolBudgetReached = false;
  let skippedFiles = 0;
  const orderedFiles = [...inventoryFiles].sort((a, b) => Number(isHiddenRelativePath(a.path)) - Number(isHiddenRelativePath(b.path)) || a.path.localeCompare(b.path));
  for (const file of orderedFiles) {
    if (!SOURCE_LANGUAGES.has(file.language) || file.generated) continue;
    if (extracted.length >= config.analysisLimits.maxAnalyzedFiles || scannedBytes + file.bytes > config.analysisLimits.maxScannedBytes) {
      sourceBudgetReached = true;
      break;
    }
    let text: string;
    try {
      const resolved = guard.resolve(workspace, file.path);
      text = await fsp.readFile(resolved.absPath, "utf8");
    } catch {
      skippedFiles += 1;
      continue;
    }
    const actualBytes = Buffer.byteLength(text, "utf8");
    if (scannedBytes + actualBytes > config.analysisLimits.maxScannedBytes) {
      sourceBudgetReached = true;
      break;
    }
    scannedBytes += actualBytes;
    const symbols: AnalysisSymbol[] = [];
    const imports: string[] = [];
    const importRecords: ExtractedImport[] = [];
    let redactedLines: string[] | undefined;
    const pythonImports = file.language === "python" ? pythonImportStatements(text) : undefined;
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      for (const pattern of DECLARATIONS[file.language] ?? []) {
        const match = line.match(pattern.regex);
        if (!match?.[1]) continue;
        if (symbolCount >= config.analysisLimits.maxSymbols) {
          symbolBudgetReached = true;
          continue;
        }
        symbols.push({ name: match[1], kind: pattern.kind, path: file.path, line: index + 1, exported: /\b(export|public|pub)\b/.test(line), confidence: "strong" });
        symbolCount += 1;
      }
      const statements = file.language === "python"
        ? pythonImports?.get(index + 1) ?? []
        : importSpecifiers(file.language, line);
      for (const statement of statements) {
        for (const target of resolveInternalImports(file.path, statement, fileSet, file.language)) {
          if (!target || target === file.path) continue;
          redactedLines ??= redactSensitiveTextPreservingLines(text, {
            context: "source",
            language: sourceLanguageForPath(file.path)
          }).split(/\r?\n/);
          const sourceLine = (redactedLines[index] ?? line).trim().slice(0, 400);
          if (!importRecords.some((record) => record.target === target && record.line === index + 1)) {
            importRecords.push({ target, line: index + 1, text: sourceLine });
          }
          if (!imports.includes(target)) imports.push(target);
        }
      }
    }
    extracted.push({ path: file.path, text, symbols, imports, importRecords });
  }
  const warnings = [
    ...(sourceBudgetReached ? ["Source analysis reached its file or byte limit."] : []),
    ...(symbolBudgetReached ? ["Symbol extraction reached its configured limit."] : []),
    ...(skippedFiles ? [`Skipped ${skippedFiles} source file${skippedFiles === 1 ? "" : "s"} that changed or became unreadable during analysis.`] : [])
  ];
  return {
    files: extracted,
    analyzedFiles: extracted.length,
    scannedBytes,
    truncated: sourceBudgetReached || symbolBudgetReached || skippedFiles > 0,
    warnings
  };
}
