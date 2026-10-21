/**
 * Inventory of installed extensions (plugins, skills, commands, agents, MCP servers). New or
 * changed items are scanned at session start and at the end of a turn, so whatever got installed
 * outside an intercepted command (the /plugin UI, a manual copy) is still checked before it is used.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { readJson, writeJson } from "../fsutil.js";
import { claudeConfigDir, stateDir } from "../paths.js";
import { type Finding, type McpEntry, scanMcpServer, scanPath, sortFindings, verdictOf, type Verdict } from "./index.js";

export type ItemKind = "plugin" | "skill" | "command" | "agent" | "mcp";

export interface InventoryItem {
  id: string;
  kind: ItemKind;
  name: string;
  path?: string;
  mcp?: { source: string; entry: McpEntry };
}

export interface FlaggedItem {
  item: InventoryItem;
  verdict: Verdict;
  findings: Finding[];
}

interface InventoryState {
  checkedAt?: number;
  items: Record<string, { fp: string; verdict: Verdict; findings: number; scannedAt: number }>;
}

const inventoryFile = () => join(stateDir(), "inventory.json");
const SELF = "steinwall";

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function addDirItems(items: InventoryItem[], dir: string, kind: ItemKind, scope: string): void {
  for (const name of listDir(dir)) {
    const path = join(dir, name);
    if (kind === "skill" ? existsSync(join(path, "SKILL.md")) : name.endsWith(".md")) {
      items.push({ id: `${kind}:${scope}:${name}`, kind, name: name.replace(/\.md$/, ""), path });
    }
  }
}

function addMcpItems(items: InventoryItem[], servers: unknown, source: string): void {
  if (!servers || typeof servers !== "object") return;
  for (const [name, entry] of Object.entries(servers as Record<string, McpEntry>)) {
    if (entry && typeof entry === "object") items.push({ id: `mcp:${source}:${name}`, kind: "mcp", name, mcp: { source, entry } });
  }
}

/**
 * Data folders of the Claude desktop app (Claude-Data/claude_<id>). The bundled Claude Code
 * binary lives in <root>/claude-code/<version>/<hash>/, and Claude Code passes its path to hooks.
 * The default locations are fallbacks; the folder layout is the app's and may change.
 */
export function desktopDataRoots(env: NodeJS.ProcessEnv = process.env): string[] {
  const roots = new Set<string>();
  const exec = env.CLAUDE_CODE_EXECPATH?.replace(/\\/g, "/");
  const m = exec ? /^(.*\/Claude-Data\/[^/]+)\/claude-code\//i.exec(exec) : null;
  if (m) roots.add(m[1]!);
  const bases = [env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Claude-Data"), join(homedir(), "Library", "Application Support", "Claude-Data")];
  for (const base of bases) {
    if (!base) continue;
    for (const name of listDir(base)) if (name.startsWith("claude_")) roots.add(join(base, name).replace(/\\/g, "/"));
  }
  return [...roots];
}

/** Plugin folders (with <manifestDir>/plugin.json) up to `depth` levels below `dir`. */
function findPluginDirs(dir: string, depth: number, out: string[] = [], manifestDir = ".claude-plugin"): string[] {
  if (existsSync(join(dir, manifestDir, "plugin.json"))) {
    out.push(dir);
    return out;
  }
  if (depth <= 0) return out;
  for (const name of listDir(dir)) {
    const path = join(dir, name);
    try {
      if (statSync(path).isDirectory()) findPluginDirs(path, depth - 1, out, manifestDir);
    } catch {
      // vanished
    }
  }
  return out;
}

export const codexHome = () => process.env.CODEX_HOME || join(homedir(), ".codex");

/**
 * MCP servers from Codex's config.toml (`[mcp_servers.<name>]` with command, args, url).
 * A minimal reader for exactly these keys, to stay dependency-free.
 */
export function codexMcpServers(toml: string): Record<string, McpEntry> {
  const servers: Record<string, McpEntry> = {};
  const strings = (s: string) => [...s.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => (m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[2]!));
  let current: McpEntry | null = null;
  let pendingArgs: string | null = null;
  for (const line of toml.split(/\r?\n/)) {
    if (pendingArgs !== null) {
      pendingArgs += line;
      if (line.includes("]")) {
        if (current) current.args = strings(pendingArgs);
        pendingArgs = null;
      }
      continue;
    }
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      const m = /^mcp_servers\.(?:"([^"]+)"|([\w-]+))$/.exec(header[1]!.trim());
      current = m ? (servers[m[1] ?? m[2]!] = {}) : null;
      continue;
    }
    if (!current) continue;
    const kv = /^\s*(command|url|args)\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    if (kv[1] === "args") {
      if (kv[2]!.includes("]")) current.args = strings(kv[2]!);
      else pendingArgs = kv[2]!;
    } else {
      const value = strings(kv[2]!)[0];
      if (value !== undefined) current[kv[1] as "command" | "url"] = value;
    }
  }
  return servers;
}

function addCodexItems(items: InventoryItem[], cwd?: string): void {
  const home = codexHome();
  for (const dir of findPluginDirs(join(home, "plugins", "cache"), 4, [], ".codex-plugin")) {
    const name = readJson<{ name?: string }>(join(dir, ".codex-plugin", "plugin.json"), {}).name ?? basename(dir);
    if (name === SELF) continue;
    items.push({ id: `plugin:codex:${createHash("sha1").update(dir.toLowerCase()).digest("hex").slice(0, 10)}`, kind: "plugin", name: `${name} (codex)`, path: dir });
  }
  addDirItems(items, join(home, "skills"), "skill", "codex");
  try {
    addMcpItems(items, codexMcpServers(readFileSync(join(home, "config.toml"), "utf8")), "codex config.toml");
  } catch {
    // no Codex config
  }
  if (cwd) addDirItems(items, join(cwd, ".codex", "skills"), "skill", `codex-project@${createHash("sha1").update(cwd.toLowerCase()).digest("hex").slice(0, 8)}`);
}

function addDesktopPlugins(items: InventoryItem[]): void {
  for (const root of desktopDataRoots()) {
    const dirs = [...findPluginDirs(join(root, "rpm"), 4), ...findPluginDirs(join(root, "local-agent-mode-sessions", "skills-plugin"), 3)];
    for (const dir of dirs) {
      const name = readJson<{ name?: string }>(join(dir, ".claude-plugin", "plugin.json"), {}).name ?? basename(dir);
      if (name === SELF) continue;
      items.push({ id: `plugin:desktop:${basename(dir)}`, kind: "plugin", name: `${name} (desktop)`, path: dir });
    }
  }
}

/** Everything Claude Code (and Codex, if installed) would load for a session in `cwd`. */
export function discover(cwd?: string, opts: { desktop?: boolean } = {}): InventoryItem[] {
  const items: InventoryItem[] = [];
  const claude = claudeConfigDir();
  if (opts.desktop !== false) addDesktopPlugins(items);
  addCodexItems(items, cwd);

  const installed = readJson<{ plugins?: Record<string, { installPath?: string }[]> }>(join(claude, "plugins", "installed_plugins.json"), {});
  for (const [id, installs] of Object.entries(installed.plugins ?? {})) {
    const name = id.split("@")[0] ?? id;
    if (name === SELF) continue; // SteinWall's own guard rules are full of the patterns it looks for
    const path = installs?.[0]?.installPath;
    if (path) items.push({ id: `plugin:${id}`, kind: "plugin", name: id, path });
  }

  addDirItems(items, join(claude, "skills"), "skill", "user");
  addDirItems(items, join(claude, "commands"), "command", "user");
  addDirItems(items, join(claude, "agents"), "agent", "user");

  const userConfig = readJson<{ mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> }>(process.env.CLAUDE_CONFIG_DIR ? join(claude, ".claude.json") : join(homedir(), ".claude.json"), {});
  addMcpItems(items, userConfig.mcpServers, "user");

  if (cwd) {
    // Project items are keyed by folder, so same-named skills in two projects don't overwrite each other.
    const scope = `project@${createHash("sha1").update(cwd.toLowerCase()).digest("hex").slice(0, 8)}`;
    addDirItems(items, join(cwd, ".claude", "skills"), "skill", scope);
    addDirItems(items, join(cwd, ".claude", "commands"), "command", scope);
    addDirItems(items, join(cwd, ".claude", "agents"), "agent", scope);
    addMcpItems(items, readJson<{ mcpServers?: unknown }>(join(cwd, ".mcp.json"), {}).mcpServers, `${scope} .mcp.json`);
    const projectKey = Object.keys(userConfig.projects ?? {}).find((p) => p.replace(/\\/g, "/").toLowerCase() === cwd.replace(/\\/g, "/").toLowerCase());
    if (projectKey) addMcpItems(items, userConfig.projects![projectKey]!.mcpServers, `${scope} (local)`);
  }
  return items;
}

/** Cheap change detection: file names, sizes and modification times (contents only when scanning). */
export function fingerprint(item: InventoryItem): string {
  const h = createHash("sha1");
  if (item.mcp) return h.update(JSON.stringify(item.mcp.entry)).digest("hex");
  let count = 0;
  const walk = (p: string) => {
    if (count > 3000) return;
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (["node_modules", ".git"].includes(basename(p))) return;
      for (const n of listDir(p).sort()) walk(join(p, n));
    } else {
      count++;
      h.update(`${p}|${st.size}|${st.mtimeMs}\n`);
    }
  };
  if (item.path) walk(item.path);
  return h.digest("hex");
}

export function scanItem(item: InventoryItem): FlaggedItem {
  const findings = item.mcp ? sortFindings(scanMcpServer(item.name, item.mcp.entry, item.mcp.source)) : scanPath(item.path!).findings;
  return { item, verdict: verdictOf(findings), findings };
}

/**
 * Scan what is new or changed since the last check. Call only while holding the state lock.
 * Returns the flagged items among them (each reported once, until it changes again).
 */
export function checkInventory(cwd: string | undefined, trusted: string[] = [], opts: { desktop?: boolean } = {}): { scanned: number; flagged: FlaggedItem[]; flaggedNames: string[] } {
  const state = readJson<InventoryState>(inventoryFile(), { items: {} });
  const items = discover(cwd, opts).filter((i) => !trusted.some((t) => t === i.name || t === i.id));
  const flagged: FlaggedItem[] = [];
  let scanned = 0;
  for (const item of items) {
    const fp = fingerprint(item);
    if (state.items[item.id]?.fp === fp) continue;
    const result = scanItem(item);
    scanned++;
    state.items[item.id] = { fp, verdict: result.verdict, findings: result.findings.length, scannedAt: Date.now() };
    // Only "do not install" verdicts are announced; "suspicious" ones show up in `scan --installed`.
    if (result.verdict === "block") flagged.push(result);
  }
  // Forget items that are gone, but only those this cwd could see (project items of other folders stay).
  const seen = new Set(items.map((i) => i.id));
  for (const id of Object.keys(state.items)) {
    if (!seen.has(id) && !id.includes(":project") && !id.includes(":codex-project")) delete state.items[id];
  }
  state.checkedAt = Date.now();
  writeJson(inventoryFile(), state);
  // Everything installed that is (still) flagged, for the agent's context.
  const flaggedNames = items.filter((i) => state.items[i.id]?.verdict === "block").map((i) => i.name);
  return { scanned, flagged, flaggedNames };
}


export function inventoryCheckedAt(): number {
  return readJson<InventoryState>(inventoryFile(), { items: {} }).checkedAt ?? 0;
}
