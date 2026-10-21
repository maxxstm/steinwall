/**
 * Skill / plugin / MCP scanner. Scans text with the rules in rules.ts, MCP server definitions
 * against the signature list, and whole directories file by file.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { atLeast, type Category, COMBO_WINDOW_LINES, COMMENT_LINE, type Context, DISCUSSION_CONTEXT, EXFIL_COMBO, IGNORE_IN_COMMENTS, QUOTE_BEFORE, RULES, SEVERITY_ORDER, type Severity } from "./rules.js";
import { loadSignatures, matchPackage, type SignatureList, typosquatOf } from "./signatures.js";

export interface Finding {
  ruleId: string;
  category: Category;
  severity: Severity;
  file: string;
  line: number;
  excerpt: string;
}

export type Verdict = "block" | "warn" | "ok";

export interface ScanResult {
  target: string;
  findings: Finding[];
  verdict: Verdict;
  files: number;
  skipped: number;
}

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FILES = 3000;
const SKIP_DIRS = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".next", "coverage"]);
const SKIP_FILES = /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb|poetry\.lock|Cargo\.lock|composer\.lock)$/i;
const INSTRUCTION_EXT = new Set([".md", ".mdx", ".markdown", ".txt", ".prompt"]);
const SCRIPT_EXT = new Set([".sh", ".bash", ".zsh", ".fish", ".ps1", ".psm1", ".bat", ".cmd", ".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".rb", ".pl", ".php", ".lua"]);
const CONFIG_EXT = new Set([".json", ".jsonc", ".yaml", ".yml", ".toml"]);
const HUMAN_DOCS = /^(README|CHANGELOG|CHANGES|CONTRIBUTING|SECURITY|LICENSE|NOTICE|CODE_OF_CONDUCT)(\.[\w.]+)?$/i;

/** How a file is read by the agent or the system; null = not scanned (binary, assets). */
export function contextFor(path: string): Context | null {
  const name = basename(path);
  if (SKIP_FILES.test(name)) return null;
  const ext = extname(name).toLowerCase();
  if (INSTRUCTION_EXT.has(ext)) return "instructions";
  if (SCRIPT_EXT.has(ext) || (!ext && /^[\w.-]+$/.test(name) && name !== "LICENSE")) return "script";
  if (CONFIG_EXT.has(ext)) return "config";
  return null;
}

export function verdictOf(findings: Finding[]): Verdict {
  if (findings.some((f) => atLeast(f.severity, "high"))) return "block";
  if (findings.some((f) => f.severity === "medium")) return "warn";
  return "ok";
}

function lineOf(text: string, index: number): { line: number; excerpt: string } {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  const raw = text.slice(start, end < 0 ? undefined : end).trim();
  // Make invisible characters visible in the excerpt.
  const visible = raw.replace(/[\u{E0000}-\u{E007F}​-‍⁠-⁤‪-‮⁦-⁩]/gu, (c) => `<U+${c.codePointAt(0)!.toString(16).toUpperCase()}>`);
  return { line: text.slice(0, index).split("\n").length, excerpt: visible.length > 140 ? `${visible.slice(0, 137)}...` : visible };
}

const MAX_MATCHES_PER_RULE = 50;

function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end < 0 ? undefined : end);
}

/**
 * Scan one text. One finding per rule per text: the most severe match. Matches inside script
 * comments are ignored for prose-like rules, and prompt-injection phrases that are quoted or
 * discussed (security guidance) are downgraded to "low".
 */
export function scanText(text: string, file: string, context: Context): Finding[] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text; // a BOM is not hidden text
  const findings: Finding[] = [];
  const lines = new Map<string, number[]>(); // rule id -> matched line numbers, for the combo check
  for (const rule of RULES) {
    const severity = rule.severity[context];
    if (!severity) continue;
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes("g") ? rule.pattern.flags : `${rule.pattern.flags}g`);
    let best: { severity: Severity; index: number } | null = null;
    let m: RegExpExecArray | null;
    for (let n = 0; n < MAX_MATCHES_PER_RULE && (m = re.exec(body)); n++) {
      if (m[0].length === 0) re.lastIndex++;
      const line = lineAt(body, m.index);
      if (context === "script" && IGNORE_IN_COMMENTS.has(rule.category) && COMMENT_LINE.test(line)) continue;
      let sev = severity;
      if (rule.category === "prompt-injection" && (DISCUSSION_CONTEXT.test(line) || QUOTE_BEFORE.test(body.slice(Math.max(0, m.index - 3), m.index)))) sev = "low";
      const lineNo = body.slice(0, m.index).split("\n").length;
      lines.set(rule.id, [...(lines.get(rule.id) ?? []), lineNo]);
      if (!best || SEVERITY_ORDER.indexOf(sev) > SEVERITY_ORDER.indexOf(best.severity)) best = { severity: sev, index: m.index };
    }
    if (best) findings.push({ ruleId: rule.id, category: rule.category, severity: best.severity, file, ...lineOf(body, best.index) });
  }

  // Exfiltration: secret access and a network send close to each other.
  const comboSeverity = EXFIL_COMBO.severity[context];
  if (comboSeverity) {
    const [secretRules, sendRules] = EXFIL_COMBO.needs as [string[], string[]];
    const secretLines = secretRules.flatMap((id) => lines.get(id) ?? []);
    const sendLines = sendRules.flatMap((id) => lines.get(id) ?? []);
    const hit = secretLines.find((a) => sendLines.some((b) => Math.abs(a - b) <= COMBO_WINDOW_LINES));
    if (hit !== undefined) {
      const lineIndex = body.split("\n").slice(0, hit - 1).join("\n").length + (hit > 1 ? 1 : 0);
      findings.push({ ruleId: EXFIL_COMBO.id, category: "exfiltration", severity: comboSeverity, file, ...lineOf(body, lineIndex) });
    }
  }
  return findings;
}

// --- MCP servers ------------------------------------------------------------------

export interface McpEntry {
  type?: string;
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

const NODE_RUNNERS = new Set(["npx", "bunx"]);
const PY_RUNNERS = new Set(["uvx", "pipx"]);

/** "@scope/pkg@1.2.3" -> { name, version } */
function splitNpmSpec(spec: string): { name: string; version?: string } {
  const at = spec.lastIndexOf("@");
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec };
}

function packageOf(entry: McpEntry): { ecosystem: "npm" | "pypi"; name: string; version?: string } | null {
  const cmd = basename(entry.command ?? "").toLowerCase().replace(/\.(cmd|exe)$/, "");
  let args = entry.args ?? [];
  // `cmd /c npx -y pkg` on Windows
  if (cmd === "cmd" && args[0]?.toLowerCase() === "/c") return packageOf({ command: args[1], args: args.slice(2) });
  if ((cmd === "pnpm" || cmd === "yarn") && args[0] === "dlx") return packageOf({ command: "npx", args: args.slice(1) });
  if (cmd === "pipx" && args[0] === "run") args = args.slice(1);
  if (NODE_RUNNERS.has(cmd)) {
    const flag = args.findIndex((a) => a === "-p" || a === "--package");
    const spec = flag >= 0 ? args[flag + 1] : args.find((a) => !a.startsWith("-"));
    return spec ? { ecosystem: "npm", ...splitNpmSpec(spec) } : null;
  }
  if (PY_RUNNERS.has(cmd)) {
    const from = args.indexOf("--from");
    const spec = from >= 0 ? args[from + 1] : args.find((a) => !a.startsWith("-"));
    if (!spec) return null;
    const m = /^([A-Za-z0-9_.\-[\]]+)(?:==|@)?([\w.]*)$/.exec(spec);
    return m ? { ecosystem: "pypi", name: m[1]!.replace(/\[.*\]$/, ""), version: m[2] || undefined } : null;
  }
  return null;
}

export function scanMcpServer(name: string, entry: McpEntry, source: string, signatures: SignatureList = loadSignatures()): Finding[] {
  const file = `${source} › ${name}`;
  const findings: Finding[] = [];
  const add = (ruleId: string, severity: Severity, excerpt: string, category: Category = "mcp") =>
    findings.push({ ruleId, category, severity, file, line: 0, excerpt });

  const pkg = packageOf(entry);
  if (pkg) {
    const sig = matchPackage(signatures, pkg.ecosystem, pkg.name, pkg.version);
    if (sig) add(sig.kind === "malicious" ? "known-malicious-package" : "known-vulnerable-package", sig.kind === "malicious" ? "critical" : "high", `${pkg.name}${pkg.version ? `@${pkg.version}` : ""}: ${sig.reason}`);
    const squat = typosquatOf(pkg.name);
    if (squat) add("possible-typosquat", "medium", `${pkg.name} looks like ${squat}`);
    if (!pkg.version || pkg.version === "latest") add("unpinned-package", "low", `${pkg.name} has no fixed version: every update runs unreviewed`);
  }
  if (entry.url) {
    try {
      const u = new URL(entry.url);
      const local = ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
      if (u.protocol === "http:" && !local) add("insecure-transport", "medium", `${entry.url} is not encrypted (http)`);
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(u.hostname) && !local) add("raw-ip-endpoint", "medium", `${entry.url} points to a bare IP address`);
    } catch {
      add("invalid-url", "low", entry.url);
    }
  }
  const commandLine = [entry.command, ...(entry.args ?? [])].filter(Boolean).join(" ");
  if (commandLine) for (const f of scanText(commandLine, file, "config")) findings.push({ ...f, line: 0 });
  return findings;
}

/** `{ "mcpServers": { name: entry } }` (or the map itself). */
export function scanMcpConfig(config: unknown, source: string): Finding[] {
  const servers = (config as { mcpServers?: Record<string, McpEntry> })?.mcpServers ?? (config as Record<string, McpEntry>);
  if (!servers || typeof servers !== "object") return [];
  const signatures = loadSignatures();
  return Object.entries(servers).flatMap(([name, entry]) => (entry && typeof entry === "object" ? scanMcpServer(name, entry, source, signatures) : []));
}

// --- files and directories ------------------------------------------------------------

export function scanFile(path: string, displayRoot?: string): Finding[] {
  const context = contextFor(path);
  if (!context) return [];
  const text = readFileSync(path, "utf8");
  const display = displayRoot ? relative(displayRoot, path) || basename(path) : path;
  let findings = scanText(text, display, context);
  // Human documentation is not loaded into the agent's context like SKILL.md or commands are.
  if (HUMAN_DOCS.test(basename(path))) findings = findings.map((f) => (f.severity === "medium" ? { ...f, severity: "low" } : f));
  if (basename(path).toLowerCase() === ".mcp.json") {
    try {
      findings.push(...scanMcpConfig(JSON.parse(text), display));
    } catch {
      // not JSON: text rules already applied
    }
  }
  return findings;
}

/** Scan a file or a directory tree (plugin, skill). */
export function scanPath(target: string): ScanResult {
  const findings: Finding[] = [];
  let files = 0;
  let skipped = 0;
  const visit = (path: string, root: string) => {
    let st;
    try {
      st = statSync(path);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(basename(path)) && path !== root) return;
      for (const name of readdirSync(path)) {
        if (files + skipped >= MAX_FILES) return;
        visit(join(path, name), root);
      }
      return;
    }
    if (!contextFor(path) || st.size > MAX_FILE_BYTES) {
      skipped++;
      return;
    }
    files++;
    try {
      findings.push(...scanFile(path, root));
    } catch {
      skipped++;
    }
  };
  const isDir = (() => {
    try {
      return statSync(target).isDirectory();
    } catch {
      return false;
    }
  })();
  visit(target, isDir ? target : join(target, ".."));
  return { target, findings: sortFindings(findings), verdict: verdictOf(findings), files, skipped };
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity));
}

/** Short human/agent-readable summary of the most severe findings. */
export function summarize(findings: Finding[], max = 3): string {
  const top = sortFindings(findings).filter((f) => f.severity !== "info").slice(0, max);
  const rest = findings.filter((f) => f.severity !== "info").length - top.length;
  const lines = top.map((f) => `[${f.severity}] ${f.ruleId} – ${f.file}${f.line ? `:${f.line}` : ""}: "${f.excerpt}"`);
  return lines.join("; ") + (rest > 0 ? ` (+${rest} more)` : "");
}
