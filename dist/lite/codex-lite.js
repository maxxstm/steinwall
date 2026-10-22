/**
 * SteinWall Lite for Codex: the hook-free edition for OpenAI's plugin directory, which does not
 * accept plugins with lifecycle hooks. It runs only when the user asks (through the skill) and is
 * read-only: it reads Codex's own session logs and the extension folders, and writes nothing.
 *
 *   briefing [--date YYYY-MM-DD] [--lang de|en]   cost, limits, and what full SteinWall would have caught
 *   scan <path> | scan --installed                 check skills, plugins and MCP servers
 *
 * Savings here are counterfactual ("would have saved"): Lite cannot step in, so it only measures
 * what the full edition would have stopped. Amounts are estimates at API list prices.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CONFIG } from "../core/config.js";
import { localDay } from "../core/fsutil.js";
import { checkCommand } from "../core/guard/index.js";
import { money, percent, ruleLabel } from "../core/i18n.js";
import { costUsd, normalizeModel } from "../core/pricing.js";
import { scanPath, summarize } from "../core/scanner/index.js";
import { discover, scanItem } from "../core/scanner/inventory.js";
const INSTALL = "codex plugin marketplace add maxxstm/steinwall";
const SITE = "https://steinwall.dev";
/** Full SteinWall hints after the 3rd identical failure; every further round is what it saves. */
const LOOP_HINT_AT = 3;
const DAY_MS = 86_400_000;
const emptyDay = () => ({ costUsd: 0, requests: 0, sessions: new Set(), byModel: {}, loops: [], risky: [] });
const CMD_LITERAL = /\bcmd\s*:\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
function unquote(literal) {
    if (literal.startsWith('"')) {
        try {
            return JSON.parse(literal);
        }
        catch {
            // fall through to the simple unescape
        }
    }
    return literal.slice(1, -1).replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, "\n");
}
function fromArgv(v) {
    if (typeof v === "string")
        return v;
    if (!Array.isArray(v) || !v.every((x) => typeof x === "string"))
        return null;
    const argv = v;
    // ["bash", "-lc", "<script>"] and similar wrappers: the script is what ran.
    if (argv.length === 3 && /^(ba|z)?sh$|powershell|pwsh/i.test(argv[0]) && /^-(l?c|Command)$/i.test(argv[1]))
        return argv[2];
    return argv.join(" ");
}
/** Shell commands in one tool call: the Codex app's exec cells, `shell`/`exec_command` calls, local shell. */
export function commandsOf(p) {
    if (p.type === "custom_tool_call" && typeof p.input === "string") {
        return [...p.input.matchAll(CMD_LITERAL)].map((m) => unquote(m[1]));
    }
    if (p.type === "local_shell_call") {
        const c = fromArgv(p.action?.command);
        return c ? [c] : [];
    }
    if (p.type === "function_call" && /^(shell|exec_command|container\.exec|local_shell)$/.test(p.name ?? "")) {
        let args = {};
        try {
            args = typeof p.arguments === "string" ? JSON.parse(p.arguments) : (p.arguments ?? {});
        }
        catch {
            return [];
        }
        const c = fromArgv(args.command ?? args.cmd);
        return c ? [c] : [];
    }
    return [];
}
function outputText(output) {
    if (typeof output === "string")
        return output;
    if (Array.isArray(output))
        return output.map((o) => (typeof o === "string" ? o : typeof o?.text === "string" ? o.text : "")).join("\n");
    if (output && typeof output === "object")
        return JSON.stringify(output);
    return "";
}
/** True when the tool output reports a non-zero exit code. */
export function failed(output) {
    const text = outputText(output);
    for (const m of text.matchAll(/exit_?code\\?"?\s*[:=]\s*(-?\d+)/gi))
        if (m[1] !== "0")
            return true;
    return /Process exited with code [1-9]/.test(text);
}
const normalize = (cmd) => cmd.replace(/\s+/g, " ").trim();
const shorten = (s, n = 60) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
/** Fold one rollout file into the per-day stats. */
export function readRollout(text, sessionId, days, limits) {
    const s = { id: sessionId, calls: new Map(), failures: new Map() };
    const sessionRequests = new Map();
    const dayOf = (ts) => {
        const d = ts ? new Date(ts) : null;
        return localDay(d && !Number.isNaN(d.getTime()) ? d : new Date());
    };
    const day = (d) => {
        let v = days.get(d);
        if (!v)
            days.set(d, (v = emptyDay()));
        return v;
    };
    for (const line of text.split("\n")) {
        if (!line)
            continue;
        let e;
        try {
            e = JSON.parse(line);
        }
        catch {
            continue;
        }
        const p = e.payload;
        if (!p)
            continue;
        if (e.type === "turn_context" && p.model)
            s.model = p.model;
        if (e.type === "event_msg" && p.type === "token_count") {
            const at = e.timestamp ? new Date(e.timestamp).getTime() : 0;
            if (p.rate_limits && at >= limits.at) {
                const value = {};
                for (const w of Object.values(p.rate_limits)) {
                    if (!w || typeof w.used_percent !== "number")
                        continue;
                    const entry = { usedPercent: w.used_percent, resetsAt: w.resets_at };
                    if ((w.window_minutes ?? 300) >= 24 * 60)
                        value.weekly = entry;
                    else
                        value.fiveHour = entry;
                }
                if (value.fiveHour || value.weekly)
                    Object.assign(limits, { at, value });
            }
            const last = p.info?.last_token_usage;
            const total = p.info?.total_token_usage?.total_tokens ?? 0;
            if (!last || total === s.lastTotal)
                continue; // a repeated event
            s.lastTotal = total;
            const cached = last.cached_input_tokens ?? 0;
            const cacheWrite = last.cache_write_input_tokens ?? 0;
            const usage = { input: Math.max(0, (last.input_tokens ?? 0) - cached - cacheWrite), cacheRead: cached, cacheWrite5m: cacheWrite, cacheWrite1h: 0, output: last.output_tokens ?? 0 };
            const model = s.model ?? "gpt-unknown";
            const usd = costUsd(model, usage);
            const d = dayOf(e.timestamp);
            const stats = day(d);
            stats.costUsd += usd;
            stats.requests++;
            stats.sessions.add(sessionId);
            const key = normalizeModel(model);
            stats.byModel[key] = (stats.byModel[key] ?? 0) + usd;
            const sr = sessionRequests.get(d) ?? { usd: 0, n: 0 };
            sessionRequests.set(d, { usd: sr.usd + usd, n: sr.n + 1 });
            continue;
        }
        if (e.type !== "response_item")
            continue;
        const commands = commandsOf(p);
        if (commands.length) {
            const d = dayOf(e.timestamp);
            for (const command of commands) {
                const finding = checkCommand(command, DEFAULT_CONFIG)[0];
                if (finding && finding.rule !== "self-protect")
                    day(d).risky.push({ rule: finding.rule, command: shorten(normalize(command)) });
            }
            // Only single-command calls can be matched to their exit code.
            if (commands.length === 1 && p.call_id)
                s.calls.set(p.call_id, { command: normalize(commands[0]), day: d });
        }
        if ((p.type === "custom_tool_call_output" || p.type === "function_call_output" || p.type === "local_shell_call_output") && p.call_id) {
            const call = s.calls.get(p.call_id);
            if (call && failed(p.output)) {
                const f = s.failures.get(call.command) ?? { count: 0, day: call.day };
                s.failures.set(call.command, { count: f.count + 1, day: call.day });
            }
        }
    }
    for (const [command, f] of s.failures) {
        if (f.count < LOOP_HINT_AT)
            continue;
        const sr = sessionRequests.get(f.day);
        const perRound = sr && sr.n ? sr.usd / sr.n : 0;
        day(f.day).loops.push({ command: shorten(command), failures: f.count, wastedUsd: (f.count - (LOOP_HINT_AT - 1)) * perRound });
    }
}
function codexHome() {
    return process.env.CODEX_HOME || join(homedir(), ".codex");
}
/** Rollout files of the given days (Codex files them under sessions/YYYY/MM/DD by start date). */
function rolloutFiles(dates) {
    const out = [];
    for (const date of dates) {
        const dir = join(codexHome(), "sessions", ...date.split("-"));
        let names = [];
        try {
            names = readdirSync(dir);
        }
        catch {
            continue;
        }
        for (const n of names)
            if (n.startsWith("rollout-") && n.endsWith(".jsonl"))
                out.push({ path: join(dir, n), id: n.slice(8, -6) });
    }
    return out;
}
export function collect(dates) {
    const days = new Map();
    const limits = { at: 0, value: {} };
    // Sessions that started a day before the window can still run into it.
    const earliest = dates[dates.length - 1];
    const before = localDay(new Date(new Date(`${earliest}T12:00:00`).getTime() - DAY_MS));
    for (const f of rolloutFiles([...dates, before])) {
        try {
            if (statSync(f.path).size > 200 * 1024 * 1024)
                continue;
            readRollout(readFileSync(f.path, "utf8"), f.id, days, limits);
        }
        catch {
            // unreadable file: skip
        }
    }
    return { days, limits: limits.value };
}
// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------
function lastDates(end, n) {
    const base = new Date(`${end}T12:00:00`).getTime();
    return Array.from({ length: n }, (_, i) => localDay(new Date(base - i * DAY_MS)));
}
const wasted = (d) => d.loops.reduce((s, l) => s + l.wastedUsd, 0);
function resetTime(lang, sec) {
    if (!sec)
        return "";
    const d = new Date(sec < 1e12 ? sec * 1000 : sec);
    return ` (${lang === "de" ? "zurückgesetzt" : "resets"} ${d.toLocaleTimeString(lang === "de" ? "de-DE" : "en-US", { hour: "2-digit", minute: "2-digit" })})`;
}
export function buildBriefing(lang, date, days, limits) {
    const de = lang === "de";
    const row = (label, value) => `${label.padEnd(12)}${value}`;
    const today = days.get(date) ?? emptyDay();
    const week = lastDates(date, 7).map((d) => days.get(d) ?? emptyDay());
    const weekCost = week.reduce((s, d) => s + d.costUsd, 0);
    const weekWasted = week.reduce((s, d) => s + wasted(d), 0);
    const weekRisky = week.reduce((s, d) => s + d.risky.length, 0);
    const yesterday = days.get(lastDates(date, 2)[1]) ?? emptyDay();
    const isToday = date === localDay();
    const fmtDate = new Date(`${date}T12:00:00`).toLocaleDateString(de ? "de-DE" : "en-US", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
    const lines = [`SteinWall Lite · ${de ? "Tagesbriefing" : "Daily briefing"} ${fmtDate} (Codex)`];
    lines.push(row(de ? "Kosten" : "Cost", `≈ ${money(lang, today.costUsd)} ${de ? "(API-Gegenwert)" : "(API equivalent)"} · ${today.sessions.size} ${de ? "Sitzung(en)" : "session(s)"} · ${today.requests} ${de ? "Anfragen" : "requests"}`));
    const models = Object.entries(today.byModel).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([m, usd]) => `${m} ≈ ${money(lang, usd)}`).join(" · ");
    if (models)
        lines.push(row(de ? "Modelle" : "Models", models));
    const lim = [
        limits.fiveHour && `${de ? "5 Stunden" : "5-hour"} ${percent(lang, limits.fiveHour.usedPercent / 100)}${resetTime(lang, limits.fiveHour.resetsAt)}`,
        limits.weekly && `${de ? "Woche" : "weekly"} ${percent(lang, limits.weekly.usedPercent / 100)}`,
    ].filter(Boolean);
    if (lim.length)
        lines.push(row("Limits", lim.join(" · ")));
    lines.push(row(de ? "Gestern" : "Yesterday", `≈ ${money(lang, yesterday.costUsd)}`), row(de ? "7 Tage" : "7 days", `≈ ${money(lang, weekCost)}`));
    lines.push("", de ? `Was das volle SteinWall ${isToday ? "heute" : "an diesem Tag"} abgefangen hätte` : `What full SteinWall would have caught ${isToday ? "today" : "that day"}`);
    if (today.loops.length) {
        const w = wasted(today);
        lines.push(row(de ? "Schleifen" : "Loops", de ? `${today.loops.length} festgefahrene Schleife(n) (gleicher Befehl 3x+ fehlgeschlagen): ≈ ${money(lang, w)} wären gespart worden` : `${today.loops.length} stuck loop(s) (same command failed 3+ times): ≈ ${money(lang, w)} could have been saved`));
        for (const l of today.loops.slice(0, 2))
            lines.push(row("", `${l.failures}x  ${l.command}`));
    }
    if (today.risky.length) {
        lines.push(row(de ? "Riskant" : "Risky", de ? `${today.risky.length} Aktion(en), die es gestoppt oder zur Freigabe vorgelegt hätte` : `${today.risky.length} action(s) it would have stopped or held for approval`));
        for (const r of today.risky.slice(0, 2))
            lines.push(row("", `${ruleLabel(lang, r.rule)}: ${r.command}`));
    }
    if (!today.loops.length && !today.risky.length)
        lines.push(row("", de ? "Nichts: keine festgefahrenen Schleifen, keine riskanten Befehle." : "Nothing: no stuck loops, no risky commands."));
    if (weekWasted > 0 || weekRisky > 0) {
        const parts = [
            weekWasted > 0 && (de ? `≈ ${money(lang, weekWasted)} in Schleifen verloren` : `≈ ${money(lang, weekWasted)} lost in loops`),
            weekRisky > 0 && (de ? `${weekRisky} riskante Aktion(en)` : `${weekRisky} risky action(s)`),
        ].filter(Boolean);
        lines.push(row(de ? "7 Tage" : "7 days", parts.join(" · ")));
    }
    lines.push("", de
        ? `→ SteinWall für Codex (kostenlos) greift automatisch ein: Kostenbremse, Aktionsschutz, Schleifen-Rettung, Übergabe vor dem Limit, Prüfung vor jeder Installation. Installieren: ${INSTALL}`
        : `→ SteinWall for Codex (free) steps in automatically: cost brake, action guard, loop rescue, handoff before the limit, a check before every install. Install: ${INSTALL}`, de
        ? `→ SteinWall Pro für Claude Code und Codex spart zusätzlich: günstigere Subagenten in Claude Code, Kontext-Berater, gekürzte Tool-Ausgaben, Projektregeln, Dashboard. 5 Tage kostenlos testen: ${SITE}`
        : `→ SteinWall Pro for Claude Code and Codex saves more: cheaper subagents in Claude Code, context advisor, trimmed tool output, project rules, dashboard. Try it free for 5 days: ${SITE}`, de ? "Alle Beträge sind Schätzungen zu API-Listenpreisen. SteinWall Lite liest nur Codex' eigene Sitzungsprotokolle; nichts verlässt den Rechner." : "All amounts are estimates at API list prices. SteinWall Lite only reads Codex's own session logs; nothing leaves the machine.");
    return lines.join("\n");
}
function scanReport(lang, args) {
    const de = lang === "de";
    const hint = de ? `→ Das volle SteinWall prüft das automatisch vor jeder Installation: ${INSTALL}` : `→ Full SteinWall checks this automatically before every install: ${INSTALL}`;
    if (args.includes("--installed")) {
        const items = discover(process.cwd());
        const flagged = items.map(scanItem).filter((r) => r.verdict !== "ok");
        const lines = [de ? `SteinWall Lite · ${items.length} Erweiterungen geprüft, ${flagged.length} auffällig` : `SteinWall Lite · ${items.length} extensions scanned, ${flagged.length} flagged`];
        for (const f of flagged.slice(0, 10))
            lines.push(`${f.verdict === "block" ? (de ? "GEFÄHRLICH" : "DANGEROUS") : de ? "verdächtig" : "suspicious"}  ${f.item.name}: ${summarize(f.findings, 2)}`);
        lines.push(hint);
        return lines.join("\n");
    }
    const target = args.find((a, i) => !a.startsWith("--") && args[i - 1] !== "--lang");
    if (!target)
        return de ? "Pfad fehlt: scan <pfad> oder scan --installed" : "Missing path: scan <path> or scan --installed";
    const r = scanPath(target);
    const verdict = { block: de ? "GEFÄHRLICH – nicht installieren" : "DANGEROUS – do not install", warn: de ? "verdächtig – prüfen" : "suspicious – review", ok: de ? "unauffällig" : "clean" }[r.verdict];
    const lines = [`SteinWall Lite · ${target}: ${verdict} (${r.files} ${de ? "Dateien" : "files"})`];
    if (r.findings.length)
        lines.push(summarize(r.findings, 5));
    lines.push(hint);
    return lines.join("\n");
}
function detectLanguage(args) {
    const i = args.indexOf("--lang");
    const explicit = i >= 0 ? args[i + 1] : undefined;
    if (explicit === "de" || explicit === "en")
        return explicit;
    const env = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || Intl.DateTimeFormat().resolvedOptions().locale || "";
    return env.toLowerCase().startsWith("de") ? "de" : "en";
}
export function main(argv) {
    const [cmd = "briefing", ...args] = argv;
    const lang = detectLanguage(args);
    if (cmd === "scan")
        return scanReport(lang, args);
    if (cmd === "briefing") {
        const i = args.indexOf("--date");
        const date = i >= 0 && /^\d{4}-\d{2}-\d{2}$/.test(args[i + 1] ?? "") ? args[i + 1] : localDay();
        const { days, limits } = collect(lastDates(date, 8));
        return buildBriefing(lang, date, days, limits);
    }
    return "Usage: steinwall-lite briefing [--date YYYY-MM-DD] | scan <path> | scan --installed";
}
