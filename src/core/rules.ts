/**
 * Pro: custom rules per project or folder. A `.steinwall/rules.json` in a project (or any parent
 * folder of the session's cwd) and the global `~/.steinwall/rules.json` add to the built-in guard:
 *
 *   {
 *     "deny":  ["terraform apply", "^kubectl delete"],      // regexes on shell commands
 *     "ask":   ["^npm publish"],
 *     "allow": ["^rm -rf \\./tmp-"],                         // skip the guard for these commands
 *     "protect": ["infra/prod/**", "*.sqlite"],              // paths agents may not write or delete
 *     "message": "Prod infra is changed through the release pipeline only."
 *   }
 *
 * The nearest file wins for "message"; lists from all files are combined. Files are read fresh on
 * each call; they are small.
 */
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readJson } from "./fsutil.js";
import { steinwallHome } from "./paths.js";
import { parsePatch, patchText } from "./guard/patch.js";

export interface RuleFile {
  deny?: string[];
  ask?: string[];
  allow?: string[];
  protect?: string[];
  message?: string;
}

export interface CustomVerdict {
  decision: "deny" | "ask";
  reason: string;
  source: string;
}

export function loadRules(cwd?: string): { files: string[]; rules: Required<Omit<RuleFile, "message">> & { message?: string } } {
  const files: string[] = [];
  const merged = { deny: [] as string[], ask: [] as string[], allow: [] as string[], protect: [] as string[], message: undefined as string | undefined };
  const add = (file: string, base: string) => {
    const r = readJson<RuleFile | null>(file, null);
    if (!r) return;
    files.push(file);
    for (const k of ["deny", "ask", "allow"] as const) if (Array.isArray(r[k])) merged[k].push(...r[k]!.filter((x) => typeof x === "string"));
    // Patterns with a folder are relative to the rules file's project; bare names ("*.sqlite") match anywhere.
    if (Array.isArray(r.protect)) merged.protect.push(...r.protect.filter((x) => typeof x === "string").map((p) => (isAbsolute(p) || !/[\\/]/.test(p) ? p : join(base, p))));
    merged.message ??= typeof r.message === "string" ? r.message : undefined;
  };
  if (cwd) {
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
      add(join(dir, ".steinwall", "rules.json"), dir);
      if (dirname(dir) === dir) break;
    }
  }
  add(join(steinwallHome(), "rules.json"), process.cwd());
  return { files, rules: merged };
}

function regex(source: string): RegExp | null {
  try {
    return new RegExp(source, "i");
  } catch {
    return null;
  }
}

/** Minimal glob: ** = any path, * = any name part, ? = one char. Matched against forward-slash paths. */
export function globToRegex(glob: string): RegExp {
  const g = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    if (c === "*" && g[i + 1] === "*") {
      re += ".*";
      i++;
      if (g[i + 1] === "/") i++;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`, "i");
}

function protectedHit(path: string, cwd: string | undefined, protect: string[]): string | null {
  const abs = (isAbsolute(path) ? path : resolve(cwd ?? ".", path)).replace(/\\/g, "/");
  for (const p of protect) {
    const pattern = p.replace(/\\/g, "/");
    // Patterns without a slash match the file name anywhere ("*.sqlite").
    const target = pattern.includes("/") ? abs : abs.split("/").pop()!;
    if (globToRegex(pattern).test(target) || (pattern.includes("/") && globToRegex(`${pattern}/**`).test(abs))) return p;
  }
  return null;
}

const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);

/**
 * Evaluate the custom rules for a tool call. Returns `"allow"` when an allow rule matches a shell
 * command (the built-in guard is skipped then), a verdict, or null.
 */
export function checkCustomRules(tool: string, input: Record<string, unknown>, cwd: string | undefined): CustomVerdict | "allow" | null {
  const { files, rules } = loadRules(cwd);
  if (!files.length) return null;
  const source = relative(cwd ?? ".", files[0]!) || files[0]!;
  const why = (what: string) => (rules.message ? `${what} – ${rules.message}` : what);
  const t = tool.toLowerCase();

  const command = typeof input.command === "string" && t !== "apply_patch" ? input.command : null;
  if (command !== null) {
    if (rules.deny.some((r) => regex(r)?.test(command))) return { decision: "deny", reason: why(`project rule (deny): ${command.slice(0, 120)}`), source };
    if (rules.allow.some((r) => regex(r)?.test(command))) return "allow";
    if (rules.ask.some((r) => regex(r)?.test(command))) return { decision: "ask", reason: why(`project rule (ask): ${command.slice(0, 120)}`), source };
    // Deleting or overwriting protected paths from the shell.
    if (rules.protect.length && /\b(rm|del|remove-item|mv|move|cp|truncate|tee|sed\s+-i|set-content|out-file)\b|>/.test(command)) {
      for (const token of command.split(/\s+/)) {
        const hit = token && !token.startsWith("-") ? protectedHit(token.replace(/^["']|["']$/g, ""), cwd, rules.protect) : null;
        if (hit) return { decision: "deny", reason: why(`protected path (${hit}): ${token}`), source };
      }
    }
    return null;
  }

  const paths: string[] = [];
  if (t === "apply_patch") {
    const text = patchText(input);
    if (text) for (const f of parsePatch(text)) paths.push(...[f.path, f.moveTo].filter((p): p is string => !!p));
  } else if (WRITE_TOOLS.has(t)) {
    for (const k of ["file_path", "notebook_path"]) if (typeof input[k] === "string") paths.push(input[k] as string);
  }
  for (const p of paths) {
    const hit = protectedHit(p, cwd, rules.protect);
    if (hit) return { decision: "deny", reason: why(`protected path (${hit}): ${p}`), source };
  }
  return null;
}
