import type { Config, RuleId } from "../config.js";
import { steinwallHome } from "../paths.js";
import { parsePatch, patchText } from "./patch.js";
import { isSecretPath } from "./secrets.js";
import { commandName, effectiveArgs, parseShell, type Segment } from "./shell.js";

export type GuardRule = RuleId | "self-protect";

export interface Finding {
  rule: GuardRule;
  /** Rule-level verdict before config: "deny" for catastrophic variants, otherwise "ask". */
  severity: "deny" | "ask";
  /** The offending command or path, for messages and logs. */
  subject: string;
}

export interface GuardDecision extends Finding {
  decision: "deny" | "ask";
}

export interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
}

const SHELL_TOOLS = new Set(["bash", "powershell", "shell", "local_shell", "exec_command"]);
const PATH_KEYS = ["file_path", "notebook_path", "path", "pattern", "glob"];
const WRITE_TOOLS = new Set(["write", "edit", "multiedit", "notebookedit"]);

/**
 * Decide whether a tool call must be denied or needs the user's approval.
 * Returns null when the call may proceed. Configured "off" rules are skipped, "deny" rules
 * escalate every finding; catastrophic findings (e.g. `rm -rf /`) are always denied.
 */
export function checkToolCall(call: ToolCall, cfg: Config): GuardDecision | null {
  if (!cfg.guard.enabled) return null;
  const tool = call.tool.toLowerCase();
  const command = typeof call.input.command === "string" ? call.input.command : null;

  let findings: Finding[] = [];
  const patch = tool === "apply_patch" ? patchText(call.input) : null;
  if (patch !== null) {
    // Codex: the paths are inside the patch text; every touched path is a write.
    for (const f of parsePatch(patch)) {
      for (const path of [f.path, f.moveTo].filter((p): p is string => !!p)) {
        if (isSteinWallState(path)) findings.push({ rule: "self-protect", severity: "deny", subject: path });
        else if (isSecretPath(path)) findings.push({ rule: "secret-access", severity: "ask", subject: path });
      }
    }
  } else if (SHELL_TOOLS.has(tool) && command !== null) {
    if (cfg.guard.allow.some((re) => safeRegex(re)?.test(command))) return null;
    findings = checkCommand(command, cfg);
  } else {
    for (const key of PATH_KEYS) {
      const value = call.input[key];
      if (typeof value !== "string") continue;
      if (WRITE_TOOLS.has(tool) && isSteinWallState(value)) findings.push({ rule: "self-protect", severity: "deny", subject: value });
      else if (isSecretPath(value)) findings.push({ rule: "secret-access", severity: "ask", subject: value });
    }
  }

  let result: GuardDecision | null = null;
  for (const f of findings) {
    const mode = f.rule === "self-protect" ? "deny" : cfg.guard.rules[f.rule];
    if (mode === "off") continue;
    const decision = mode === "deny" || f.severity === "deny" ? "deny" : "ask";
    if (!result || (decision === "deny" && result.decision === "ask")) result = { ...f, decision };
  }
  return result;
}

function safeRegex(source: string): RegExp | null {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

export function checkCommand(command: string, cfg: Config): Finding[] {
  const segments = parseShell(command);
  const findings: Finding[] = [];
  const subject = command.length > 200 ? `${command.slice(0, 197)}...` : command;

  for (const seg of segments) {
    const args = effectiveArgs(seg.tokens);
    if (!args.length) continue;
    const del = recursiveDelete(args, cfg);
    if (del) findings.push({ rule: "recursive-delete", severity: del, subject });
    const git = gitRisk(args);
    if (git) findings.push({ rule: git, severity: "ask", subject });
    if (downloadsExecutable(args)) findings.push({ rule: "download-exec", severity: "ask", subject });
    if (touchesSecrets(args)) findings.push({ rule: "secret-access", severity: "ask", subject });
    if (tampersWithSteinWall(args, command)) findings.push({ rule: "self-protect", severity: "deny", subject });
  }
  if (pipesDownloadIntoInterpreter(segments) || REMOTE_EXEC_PATTERNS.some((re) => re.test(command))) {
    findings.push({ rule: "remote-exec", severity: "ask", subject });
  }
  return findings;
}

// --- recursive delete ------------------------------------------------------

const DELETE_COMMANDS = new Set(["rm", "remove-item", "ri", "del", "erase", "rd", "rmdir"]);

const FIND_FILTERS = new Set(["-name", "-iname", "-path", "-ipath", "-regex", "-iregex", "-newer", "-mtime", "-mmin", "-size", "-empty", "-user"]);

/** Returns the severity, or null when the command is not a (risky) recursive delete. */
function recursiveDelete(args: string[], cfg: Config): "deny" | "ask" | null {
  const name = commandName(args[0]!);
  const rest = args.slice(1);
  let recursive = false;
  let noPreserveRoot = false;
  /** `find . -name '*.log' -delete` only removes matching files: worth asking about, not a catastrophe. */
  let filtered = false;
  const targets: string[] = [];

  if (DELETE_COMMANDS.has(name)) {
    for (const a of rest) {
      const l = a.toLowerCase();
      if (l === "--recursive") recursive = true;
      else if (l === "--no-preserve-root") noPreserveRoot = recursive = true;
      else if (l === "-r" || l.startsWith("-rec") || l === "/s") recursive = true;
      else if (name === "rm" && /^-[a-z]+$/i.test(a) && /r/i.test(a)) recursive = true;
      else if (a.startsWith("-") || (name !== "rm" && /^\/[a-z]$/i.test(a)) || a === ">" || a === "<") continue;
      else targets.push(a);
    }
  } else if (name === "find") {
    recursive = rest.includes("-delete") || rest.some((a, i) => a === "-exec" && commandName(rest[i + 1] ?? "") === "rm");
    for (const a of rest) {
      if (a.startsWith("-") || a === "!" || a === "(") break;
      targets.push(a);
    }
    if (!targets.length) targets.push(".");
    filtered = rest.some((a) => FIND_FILTERS.has(a.toLowerCase()));
  }
  if (!recursive) return null;
  if (noPreserveRoot || (!filtered && targets.some(isCatastrophicTarget))) return "deny";
  if (targets.length && targets.every((t) => isSafeDeleteTarget(t, cfg.guard.safeDeleteTargets))) return null;
  return "ask";
}

function normalizeTarget(target: string): string {
  let s = target.trim().replace(/\\/g, "/").toLowerCase();
  if (s.length > 1) s = s.replace(/\/+$/, "");
  if (s.endsWith("/*")) s = s.slice(0, -2) || "/";
  if (s.endsWith("/.")) s = s.slice(0, -2) || "/";
  return s;
}

const CATASTROPHIC = new Set(["/", "~", "$home", "${home}", "*", ".", "..", "./*", "$env:userprofile", "%userprofile%", "$env:homepath"]);

export function isCatastrophicTarget(target: string): boolean {
  const s = normalizeTarget(target);
  return (
    CATASTROPHIC.has(s) ||
    /^[a-z]:\/?$/.test(s) ||
    /^\/(usr|etc|bin|sbin|lib|lib64|var|opt|home|users|system|library|applications|boot|root|srv|private|mnt)$/.test(s) ||
    /^[a-z]:\/(windows|program files( \(x86\))?|programdata|users)$/.test(s) ||
    /^(~|\$home|\$env:userprofile)\/(documents|desktop|downloads|pictures|projects|code|dev|src|library)$/.test(s)
  );
}

function isSafeDeleteTarget(target: string, safeNames: string[]): boolean {
  const s = normalizeTarget(target);
  if (/^([a-z]:|\/|~|\$)/.test(s) || s.split("/").includes("..")) return false;
  const last = s.split("/").pop() ?? "";
  return safeNames.some((n) => n.toLowerCase() === last);
}

// --- git ---------------------------------------------------------------------

function gitRisk(args: string[]): "force-push" | "git-destructive" | null {
  if (commandName(args[0]!) !== "git") return null;
  let i = 1;
  while (i < args.length && args[i]!.startsWith("-")) i += args[i] === "-C" || args[i] === "-c" ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  const shortFlags = rest.filter((a) => /^-[a-zA-Z]+$/.test(a)).join("");

  if (sub === "push") {
    const force =
      rest.some((a) => a === "--force" || a.startsWith("--force-with-lease") || a === "--mirror" || a === "--delete") ||
      /[fd]/.test(shortFlags) ||
      rest.some((a) => !a.startsWith("-") && (a.startsWith("+") || a.startsWith(":")));
    return force ? "force-push" : null;
  }
  if (sub === "reset" && rest.includes("--hard")) return "git-destructive";
  if (sub === "clean" && (/f/.test(shortFlags) || rest.includes("--force"))) return "git-destructive";
  if (sub === "branch" && (/D/.test(shortFlags) || (rest.includes("--delete") && rest.includes("--force")))) return "git-destructive";
  if (sub === "stash" && rest[0] === "clear") return "git-destructive";
  if ((sub === "checkout" || sub === "restore") && rest.includes("--") && rest.slice(rest.indexOf("--") + 1).includes(".")) {
    return "git-destructive";
  }
  return null;
}

// --- downloads & remote execution --------------------------------------------

const DOWNLOADERS = new Set(["curl", "wget", "iwr", "invoke-webrequest", "irm", "invoke-restmethod", "aria2c", "fetch"]);
const SHELL_INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "iex", "invoke-expression", "powershell", "pwsh", "cmd"]);
const SCRIPT_INTERPRETERS = new Set(["python", "python3", "py", "node", "perl", "ruby", "php", "deno", "bun"]);
const EXECUTABLE = /\.(sh|bash|zsh|exe|msi|ps1|psm1|bat|cmd|bin|run|appimage|deb|rpm|pkg|dmg|jar|scr|vbs)(\?.*)?$/i;

const REMOTE_EXEC_PATTERNS = [
  /<\(\s*(curl|wget)\b/i, // bash <(curl ...)
  /\b(iex|invoke-expression)\b[\s\S]*\b(iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|downloadfile|net\.webclient|curl|wget)\b/i,
  /\b(eval|sh|bash|zsh)\b[^|;&]*\$\(\s*(curl|wget)\b/i, // sh -c "$(curl ...)"
];

function pipesDownloadIntoInterpreter(segments: Segment[]): boolean {
  for (let i = 0; i < segments.length; i++) {
    const args = effectiveArgs(segments[i]!.tokens);
    if (!args.length || !DOWNLOADERS.has(commandName(args[0]!))) continue;
    for (let j = i + 1; j < segments.length && segments[j]!.piped; j++) {
      const next = effectiveArgs(segments[j]!.tokens);
      const name = commandName(next[0] ?? "");
      if (SHELL_INTERPRETERS.has(name)) return true;
      // `curl … | python -m json.tool` is fine; `curl … | python` or `| python -` runs the download.
      if (SCRIPT_INTERPRETERS.has(name) && next.slice(1).every((a) => a === "-")) return true;
    }
  }
  return false;
}

function downloadsExecutable(args: string[]): boolean {
  const name = commandName(args[0]!);
  if (!DOWNLOADERS.has(name)) return false;
  const rest = args.slice(1);
  const toStdout = rest.some((a, i) => /^-q?O-$/.test(a) || (a === "-O" && rest[i + 1] === "-"));
  const saves =
    name === "wget" ||
    name === "aria2c" ||
    rest.some((a) => /^(--output|--remote-name|--remote-name-all|-outfile)$/i.test(a) || (name === "curl" && /^-[a-zA-Z]*[oO]$/.test(a)));
  return saves && !toStdout && rest.some((a) => !a.startsWith("-") && EXECUTABLE.test(a));
}

// --- secrets & self-protection -------------------------------------------------

function touchesSecrets(args: string[]): boolean {
  return args.slice(1).some((a) => a.split(/[=,]/).some((part) => part && isSecretPath(part)));
}

function homeVariants(): string[] {
  const home = steinwallHome().replace(/\\/g, "/").toLowerCase();
  return [home, "~/.steinwall", "$home/.steinwall", "${home}/.steinwall", "$env:userprofile/.steinwall", "%userprofile%/.steinwall"];
}

function isSteinWallState(path: string): boolean {
  const p = path.replace(/\\/g, "/").toLowerCase();
  // The project handoff file is the agent's to write, even when the project is the home folder.
  if (p.endsWith("/.steinwall/handoff.md")) return false;
  return homeVariants().some((h) => p === h || p.startsWith(`${h}/`));
}

const MUTATING = /^(rm|del|erase|ri|remove-item|rmdir|rd|mv|move|move-item|cp|copy|copy-item|tee|set-content|add-content|out-file|truncate|sed|perl|python|python3|node|new-item|clear-content)$/;
const INTERPRETERS = new Set(["node", "python", "python3", "perl"]);

function tampersWithSteinWall(args: string[], command: string): boolean {
  // Agents must not lift their own budget or rewrite SteinWall's config/usage records.
  if (/steinwall/i.test(args[0] ?? "") || (commandName(args[0]!) === "node" && /steinwall|cli\.js/i.test(args[1] ?? ""))) {
    // Budget, configuration and consent (telemetry) are the user's decisions.
    if (/\b(override|config\s+set|setup-statusline|remove-statusline|telemetry\s+on|license\s+deactivate)\b|--(daily|monthly|plan)\b/i.test(command)) return true;
  }
  // Reading (cat, ls, a redirect to /dev/null) is fine; changing the files or redirecting into them is not.
  const redirectsIntoState = args.some((a, i) => a === ">" && isSteinWallState(args.slice(i + 1).find((n) => n !== ">") ?? ""));
  // `node ~/.steinwall/bin/steinwall.mjs status` runs the launcher; only arguments after the script count.
  const name = commandName(args[0]!);
  const operands = INTERPRETERS.has(name) ? args.slice(2) : args.slice(1);
  return redirectsIntoState || (MUTATING.test(name) && operands.some((a) => isSteinWallState(a)));
}
