import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configFile, stateDir } from "./paths.js";
import { readJson, writeJson } from "./fsutil.js";

export const RULE_IDS = [
  "recursive-delete",
  "force-push",
  "git-destructive",
  "secret-access",
  "remote-exec",
  "download-exec",
] as const;
export type RuleId = (typeof RULE_IDS)[number];
export type RuleMode = "deny" | "ask" | "off";
export type Plan = "api" | "subscription";
export type Language = "de" | "en";

export interface Config {
  language: "auto" | Language;
  /** "auto": API if ANTHROPIC_API_KEY is set for the agent, otherwise subscription. */
  plan: "auto" | Plan;
  budget: {
    dailyUsd: number | null;
    monthlyUsd: number | null;
    /** Fraction of a limit at which a one-time warning is shown. */
    warnAt: number;
    /** Subscription costs are API-equivalent estimates, not real money, so the hard stop is opt-in there. */
    enforceOnSubscription: boolean;
  };
  loop: {
    enabled: boolean;
    /** Failures before a hint to the agent. */
    hintAfter: number;
    /** Failures before a strategy change is forced (blind retries are blocked). */
    escalateAfter: number;
    /** Same-error failures before the user is told the agent is stuck. */
    notifyUserAfter: number;
    /** Identical successful calls without any file change before a hint. */
    repeatHintAfter: number;
  };
  /** Backend base URL (Supabase functions), e.g. https://<project>.supabase.co/functions/v1. Empty: offline only. */
  license: { apiUrl: string };
  /** Opt-in only: one number per day (estimated savings) plus a random install id. */
  telemetry: { enabled: boolean; asked: boolean };
  pro: {
    /** Suggest the cheap SteinWall subagents for reading/searching; credit the price difference. */
    routing: boolean;
    /** Tell the user when the context gets expensive and suggest a focused /compact. */
    contextAdvisor: boolean;
    /** Request input size (tokens) from which the context advisor speaks up. */
    contextWarnTokens: number;
    /** Codex: shorten huge tool outputs before they enter the context. */
    outputTrim: boolean;
    /** Characters of tool output above which output trimming applies. */
    outputTrimChars: number;
    /** Test feature: estimate each prompt's cost before it is sent. Off by default. */
    costCoach: boolean;
  };
  scanner: {
    enabled: boolean;
    /** Extension names or ids to skip (e.g. your own plugin under development). */
    trusted: string[];
    /** Also scan plugins provided by the Claude desktop app (found in its data folder). */
    includeDesktopPlugins: boolean;
  };
  handoff: {
    enabled: boolean;
    /** Share of the 5-hour or weekly limit at which the handoff file is requested. */
    warnAt: number;
  };
  guard: {
    enabled: boolean;
    rules: Record<RuleId, RuleMode>;
    /**
     * What an "ask" becomes in auto / bypassPermissions mode, where Claude Code would approve it
     * without showing a prompt. "deny" keeps the protection; "allow" trusts the mode.
     */
    unattendedAsk: "deny" | "allow";
    /** Regexes; a Bash command matching one of them skips the guard. */
    allow: string[];
    /** Directory names that may be deleted recursively without asking (build output, caches). */
    safeDeleteTargets: string[];
  };
}

export const DEFAULT_CONFIG: Config = {
  language: "auto",
  plan: "auto",
  budget: { dailyUsd: 25, monthlyUsd: 300, warnAt: 0.8, enforceOnSubscription: false },
  loop: { enabled: true, hintAfter: 3, escalateAfter: 5, notifyUserAfter: 8, repeatHintAfter: 6 },
  license: { apiUrl: "https://lidwpjnxoazsdicvpvbs.supabase.co/functions/v1" },
  telemetry: { enabled: false, asked: false },
  pro: { routing: true, contextAdvisor: true, contextWarnTokens: 150_000, outputTrim: true, outputTrimChars: 30_000, costCoach: false },
  scanner: { enabled: true, trusted: [], includeDesktopPlugins: true },
  handoff: { enabled: true, warnAt: 0.85 },
  guard: {
    enabled: true,
    rules: {
      "recursive-delete": "ask",
      "force-push": "ask",
      "git-destructive": "ask",
      "secret-access": "ask",
      "remote-exec": "ask",
      "download-exec": "ask",
    },
    unattendedAsk: "deny",
    allow: [],
    safeDeleteTargets: [
      "node_modules", "dist", "build", "out", ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache",
      ".svelte-kit", "coverage", "target", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
      ".gradle", ".dart_tool", ".venv", "venv",
    ],
  },
};

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain => typeof v === "object" && v !== null && !Array.isArray(v);

function merge<T>(base: T, override: unknown): T {
  if (!isPlain(base) || !isPlain(override)) return (override === undefined ? base : override) as T;
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(override)) out[k] = k in base ? merge((base as Plain)[k], v) : v;
  return out as T;
}

export function loadConfig(): Config {
  return merge(structuredClone(DEFAULT_CONFIG), readJson<unknown>(configFile(), {}));
}

export function saveConfig(cfg: Config): void {
  writeJson(configFile(), cfg);
}

export function resolvePlan(cfg: Config, env: NodeJS.ProcessEnv = process.env): Plan {
  if (cfg.plan !== "auto") return cfg.plan;
  return env.ANTHROPIC_API_KEY ? "api" : "subscription";
}

export function resolveLanguage(cfg: Config, env: NodeJS.ProcessEnv = process.env): Language {
  if (cfg.language !== "auto") return cfg.language;
  const fromEnv = env.LC_ALL || env.LC_MESSAGES || env.LANG;
  if (fromEnv) return fromEnv.toLowerCase().startsWith("de") ? "de" : "en";
  // Initializing Intl costs ~10-15 ms per process on Windows; hooks run on every tool call, so cache it.
  const cache = join(stateDir(), "locale");
  try {
    const cached = readFileSync(cache, "utf8").trim();
    if (cached === "de" || cached === "en") return cached;
  } catch {
    // not cached yet
  }
  const lang: Language = (Intl.DateTimeFormat().resolvedOptions().locale || "").toLowerCase().startsWith("de") ? "de" : "en";
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(cache, lang);
  } catch {
    // read-only home: just don't cache
  }
  return lang;
}

/**
 * Set a dotted key ("budget.dailyUsd", "guard.rules.force-push") from CLI text.
 * Only keys that exist in DEFAULT_CONFIG are accepted, and values must keep their type.
 */
export function setConfigValue(cfg: Config, key: string, raw: string): Config {
  const parts = key.split(".");
  let defaults: unknown = DEFAULT_CONFIG;
  let target: Plain = cfg as unknown as Plain;
  for (const [i, part] of parts.entries()) {
    if (!isPlain(defaults) || !(part in defaults)) throw new Error(`Unknown config key: ${key}`);
    defaults = defaults[part];
    if (i < parts.length - 1) target = target[part] as Plain;
  }
  const value = parseValue(raw);
  const last = parts[parts.length - 1]!;
  if (key === "guard.unattendedAsk") {
    if (value !== "deny" && value !== "allow") throw new Error(`${key} must be deny or allow`);
  } else if (key.startsWith("guard.rules.")) {
    if (value !== "deny" && value !== "ask" && value !== "off") throw new Error(`${key} must be deny, ask or off`);
  } else if (key === "budget.dailyUsd" || key === "budget.monthlyUsd") {
    if (value !== null && (typeof value !== "number" || value <= 0)) throw new Error(`${key} must be a positive number or off`);
  } else if (Array.isArray(defaults) ? !Array.isArray(value) : typeof value !== typeof defaults) {
    throw new Error(`${key} expects a ${Array.isArray(defaults) ? "JSON array" : typeof defaults}`);
  }
  target[last] = value;
  return cfg;
}

function parseValue(raw: string): unknown {
  if (raw === "off" || raw === "none") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
