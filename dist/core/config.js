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
];
export const DEFAULT_CONFIG = {
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
const isPlain = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function merge(base, override) {
    if (!isPlain(base) || !isPlain(override))
        return (override === undefined ? base : override);
    const out = { ...base };
    for (const [k, v] of Object.entries(override))
        out[k] = k in base ? merge(base[k], v) : v;
    return out;
}
export function loadConfig() {
    return merge(structuredClone(DEFAULT_CONFIG), readJson(configFile(), {}));
}
export function saveConfig(cfg) {
    writeJson(configFile(), cfg);
}
export function resolvePlan(cfg, env = process.env) {
    if (cfg.plan !== "auto")
        return cfg.plan;
    return env.ANTHROPIC_API_KEY ? "api" : "subscription";
}
export function resolveLanguage(cfg, env = process.env) {
    if (cfg.language !== "auto")
        return cfg.language;
    const fromEnv = env.LC_ALL || env.LC_MESSAGES || env.LANG;
    if (fromEnv)
        return fromEnv.toLowerCase().startsWith("de") ? "de" : "en";
    // Initializing Intl costs ~10-15 ms per process on Windows; hooks run on every tool call, so cache it.
    const cache = join(stateDir(), "locale");
    try {
        const cached = readFileSync(cache, "utf8").trim();
        if (cached === "de" || cached === "en")
            return cached;
    }
    catch {
        // not cached yet
    }
    const lang = (Intl.DateTimeFormat().resolvedOptions().locale || "").toLowerCase().startsWith("de") ? "de" : "en";
    try {
        mkdirSync(stateDir(), { recursive: true });
        writeFileSync(cache, lang);
    }
    catch {
        // read-only home: just don't cache
    }
    return lang;
}
/**
 * Set a dotted key ("budget.dailyUsd", "guard.rules.force-push") from CLI text.
 * Only keys that exist in DEFAULT_CONFIG are accepted, and values must keep their type.
 */
export function setConfigValue(cfg, key, raw) {
    const parts = key.split(".");
    let defaults = DEFAULT_CONFIG;
    let target = cfg;
    for (const [i, part] of parts.entries()) {
        if (!isPlain(defaults) || !(part in defaults))
            throw new Error(`Unknown config key: ${key}`);
        defaults = defaults[part];
        if (i < parts.length - 1)
            target = target[part];
    }
    const value = parseValue(raw);
    const last = parts[parts.length - 1];
    if (key === "guard.unattendedAsk") {
        if (value !== "deny" && value !== "allow")
            throw new Error(`${key} must be deny or allow`);
    }
    else if (key.startsWith("guard.rules.")) {
        if (value !== "deny" && value !== "ask" && value !== "off")
            throw new Error(`${key} must be deny, ask or off`);
    }
    else if (key === "budget.dailyUsd" || key === "budget.monthlyUsd") {
        if (value !== null && (typeof value !== "number" || value <= 0))
            throw new Error(`${key} must be a positive number or off`);
    }
    else if (Array.isArray(defaults) ? !Array.isArray(value) : typeof value !== typeof defaults) {
        throw new Error(`${key} expects a ${Array.isArray(defaults) ? "JSON array" : typeof defaults}`);
    }
    target[last] = value;
    return cfg;
}
function parseValue(raw) {
    if (raw === "off" || raw === "none")
        return null;
    try {
        return JSON.parse(raw);
    }
    catch {
        return raw;
    }
}
