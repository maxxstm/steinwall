/**
 * Limit handoff (basic). Before the 5-hour or weekly limit runs out, the agent writes
 * `.steinwall/handoff.md` in the project; the next session in that project starts from it.
 *
 * Limit data comes from Claude Code's status line input (`rate_limits`), which the status line
 * stores in ~/.steinwall/state/ratelimits.json. Without it, the fallback is a limit message in the
 * transcript: then SteinWall writes the automatic part of the handoff itself.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { Config } from "./config.js";
import { stateDir } from "./paths.js";
import { readJson, writeJson } from "./fsutil.js";
import type { SessionState } from "./session.js";

export type LimitWindow = "five_hour" | "seven_day";

export interface RateLimits {
  updatedAt: number;
  windows: Partial<Record<LimitWindow, { usedPercentage: number; resetsAt?: string }>>;
}

/** Status line data older than this is not trusted. */
const RATE_LIMIT_MAX_AGE_MS = 30 * 60 * 1000;
/** Which agent's usage limits: Claude Code and Codex have separate limits. */
export type Agent = "claude" | "codex";
const rateLimitsFile = (agent: Agent) => join(stateDir(), agent === "claude" ? "ratelimits.json" : `ratelimits-${agent}.json`);

function toIso(v: unknown): string | undefined {
  if (typeof v === "number") return new Date(v < 1e12 ? v * 1000 : v).toISOString();
  if (typeof v === "string" && v) return v;
  return undefined;
}

/** Store the `rate_limits` object Claude Code hands to the status line (or one converted from Codex). */
export function saveRateLimits(raw: unknown, now = Date.now(), agent: Agent = "claude"): void {
  if (!raw || typeof raw !== "object") return;
  const windows: RateLimits["windows"] = {};
  for (const key of ["five_hour", "seven_day"] as const) {
    const w = (raw as Record<string, unknown>)[key] as Record<string, unknown> | undefined;
    if (w && typeof w.used_percentage === "number") {
      windows[key] = { usedPercentage: w.used_percentage, resetsAt: toIso(w.resets_at) };
    }
  }
  if (Object.keys(windows).length) writeJson(rateLimitsFile(agent), { updatedAt: now, windows } satisfies RateLimits);
}

interface CodexWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

/** Codex transcripts report `primary` (5 hours) and `secondary` (weekly) windows; convert and store them. */
export function saveCodexRateLimits(raw: unknown, now = Date.now()): void {
  if (!raw || typeof raw !== "object") return;
  const converted: Record<string, { used_percentage: number; resets_at?: number }> = {};
  for (const w of [(raw as { primary?: CodexWindow }).primary, (raw as { secondary?: CodexWindow }).secondary]) {
    if (!w || typeof w.used_percent !== "number") continue;
    const key = (w.window_minutes ?? 300) >= 24 * 60 ? "seven_day" : "five_hour";
    converted[key] = { used_percentage: w.used_percent, resets_at: w.resets_at };
  }
  saveRateLimits(converted, now, "codex");
}

export interface NearLimit {
  window: LimitWindow;
  usedPercentage: number;
  resetsAt?: string;
  /** Identifies this limit window, so the handoff is requested once per window. */
  key: string;
}

/** The latest limit data from the status line, or null when there is none or it is stale. */
export function loadRateLimits(now = Date.now(), agent: Agent = "claude"): RateLimits | null {
  const limits = readJson<RateLimits | null>(rateLimitsFile(agent), null);
  return limits && now - limits.updatedAt <= RATE_LIMIT_MAX_AGE_MS ? limits : null;
}

export function nearLimit(cfg: Config, now = Date.now(), agent: Agent = "claude"): NearLimit | null {
  if (!cfg.handoff.enabled) return null;
  const limits = loadRateLimits(now, agent);
  if (!limits) return null;
  let best: NearLimit | null = null;
  for (const [window, w] of Object.entries(limits.windows) as [LimitWindow, { usedPercentage: number; resetsAt?: string }][]) {
    if (w.usedPercentage / 100 < cfg.handoff.warnAt) continue;
    if (!best || w.usedPercentage > best.usedPercentage) {
      best = { window, usedPercentage: w.usedPercentage, resetsAt: w.resetsAt, key: `${window}@${w.resetsAt ?? "?"}` };
    }
  }
  return best;
}

// --- the handoff file -----------------------------------------------------------

export const handoffDir = (cwd: string) => join(cwd, ".steinwall");
export const handoffPath = (cwd: string) => join(handoffDir(cwd), "handoff.md");

const STATUS_LINE = /^<!-- steinwall:handoff status=(open|done)[^>]*-->/;
const AUTO_START = "<!-- steinwall:auto:start -->";
const AUTO_END = "<!-- steinwall:auto:end -->";

const TEMPLATE = (now: string) => `<!-- steinwall:handoff status=open created=${now} -->
# Handoff

Written before a usage limit so the next session can continue. Change \`status=open\` to \`status=done\` in the first line once the task is finished.

## Goal

## Done

## In progress

## Open

## Next step

## Relevant files

${AUTO_START}
${AUTO_END}
`;

export interface HandoffInfo {
  path: string;
  status: "open" | "done";
  updatedAt: number;
}

export function readHandoff(cwd: string): HandoffInfo | null {
  const path = handoffPath(cwd);
  try {
    const first = readFileSync(path, "utf8").split("\n", 1)[0] ?? "";
    const m = STATUS_LINE.exec(first);
    return { path, status: m?.[1] === "done" ? "done" : "open", updatedAt: statSync(path).mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Create the handoff file if needed and refresh the section SteinWall maintains itself
 * (last request, changed files). The agent's sections are never touched.
 */
export function writeAutoSection(cwd: string, session: SessionState, reason: string, now = new Date()): string {
  const path = handoffPath(cwd);
  mkdirSync(handoffDir(cwd), { recursive: true });
  // Keep handoffs out of commits unless the user decides otherwise.
  const ignore = join(handoffDir(cwd), ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");

  let content = existsSync(path) ? readFileSync(path, "utf8") : TEMPLATE(now.toISOString());
  if (/status=done/.test(content.split("\n", 1)[0] ?? "")) {
    // A finished handoff is replaced by a fresh one.
    content = TEMPLATE(now.toISOString());
  }
  const files = session.files.map((f) => {
    const rel = relative(cwd, f);
    return `- ${rel && !rel.startsWith("..") ? rel : f}`;
  });
  const auto = [
    AUTO_START,
    "## Auto-captured by SteinWall",
    "",
    `- Updated: ${now.toISOString()} (${reason})`,
    `- Session: ${session.id}`,
    ...(session.lastPrompt ? [`- Last user request: ${session.lastPrompt.replace(/\s+/g, " ")}`] : []),
    ...(files.length ? ["- Files changed in this session:", ...files.map((f) => `  ${f}`)] : []),
    AUTO_END,
  ].join("\n");
  const start = content.indexOf(AUTO_START);
  const end = content.indexOf(AUTO_END);
  content = start >= 0 && end > start ? content.slice(0, start) + auto + content.slice(end + AUTO_END.length) : `${content.trimEnd()}\n\n${auto}\n`;
  writeFileSync(path, content);
  return path;
}

/** Transcript text that means a usage limit was hit (Claude Code's limit notices). */
export const LIMIT_HIT_PATTERN = /usage limit|limit reached|hit your (usage )?limit|limit will reset/i;
