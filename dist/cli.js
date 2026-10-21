#!/usr/bin/env node
/**
 * steinwall CLI. Used by the slash commands (/steinwall:status, :budget, :setup) and by humans.
 * Commands that lift limits are refused by the guard when an agent tries to run them through a tool.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, resolveLanguage, saveConfig, setConfigValue } from "./core/config.js";
import { evaluateBudget } from "./core/budget.js";
import { setTodayOverride } from "./core/engine.js";
import { localDay, readJson, writeJson } from "./core/fsutil.js";
import { checkToolCall } from "./core/guard/index.js";
import { money, percent, ruleLabel } from "./core/i18n.js";
import { claudeConfigDir, pluginRootFile, statuslineBackupFile, statuslineLauncher } from "./core/paths.js";
import { loadDay, monthCost } from "./core/usage.js";
import { buildReport } from "./core/report.js";
import { scanPath } from "./core/scanner/index.js";
import { discover, scanItem } from "./core/scanner/inventory.js";
import { pluginRoot } from "./adapters/claude-code/io.js";
import { runStatusline } from "./adapters/claude-code/statusline.js";
import { runBackground } from "./adapters/claude-code/background.js";
import { runMcpServer } from "./mcp/server.js";
import { openFile, writeDashboard } from "./core/dashboard.js";
import { writeCard } from "./core/card.js";
import { activateLicense, deactivateLicense, proStatus, refreshLicense } from "./core/license.js";
const de = (lang, deText, enText) => (lang === "de" ? deText : enText);
function version() {
    return readJson(join(pluginRoot(), "package.json"), {}).version ?? "?";
}
function proLine(lang) {
    const p = proStatus();
    const what = p.reason === "license"
        ? de(lang, `aktiv${p.license?.founder ? " (Gründerpreis)" : ""}, bezahlt bis ${p.license.exp.slice(0, 10)}`, `active${p.license?.founder ? " (founder price)" : ""}, paid until ${p.license.exp.slice(0, 10)}`)
        : p.reason === "grace"
            ? de(lang, "abgelaufen, Kulanzzeit läuft", "expired, grace period running")
            : p.reason === "trial"
                ? de(lang, `Testphase, noch ${p.trialDaysLeft} Tag(e)`, `trial, ${p.trialDaysLeft} day(s) left`)
                : de(lang, "aus (Free)", "off (Free)");
    return `Pro: ${what}`;
}
async function licenseAsync(args, cfg, lang) {
    const [sub, value] = args;
    if (sub === "activate") {
        if (!value)
            throw new Error("usage: steinwall license activate <key>");
        const p = activateLicense(value);
        console.log(de(lang, `Pro aktiviert, bezahlt bis ${p.exp.slice(0, 10)}.`, `Pro activated, paid until ${p.exp.slice(0, 10)}.`));
        if (p.ref)
            console.log(de(lang, `Dein Empfehlungscode: ${p.ref} (1 Monat Pro gratis pro geworbenem Pro-Nutzer)`, `Your referral code: ${p.ref} (1 free month of Pro per referred Pro user)`));
        return 0;
    }
    if (sub === "refresh") {
        const r = await refreshLicense(cfg.license.apiUrl);
        if (!args.includes("--quiet"))
            console.log(r);
        return 0;
    }
    if (sub === "deactivate") {
        deactivateLicense();
        console.log(de(lang, "Lizenz entfernt.", "License removed."));
        return 0;
    }
    console.log(proLine(lang));
    return 0;
}
function license(args, cfg, lang) {
    licenseAsync(args, cfg, lang).then((code) => (process.exitCode = code), (err) => {
        console.error(`steinwall: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
    });
    return 0;
}
/** Consent is the user's decision: set it explicitly, never pre-selected. */
function telemetry(choice, cfg, lang) {
    if (choice === "on" || choice === "off") {
        cfg.telemetry = { enabled: choice === "on", asked: true };
        saveConfig(cfg);
    }
    return cfg.telemetry.enabled
        ? de(lang, "Anonymer Beitrag zum Ersparnis-Zähler: an (eine Zahl pro Tag + zufällige Installations-ID). Abschalten: steinwall telemetry off", "Anonymous contribution to the savings counter: on (one number per day + random install id). Turn off: steinwall telemetry off")
        : de(lang, "Anonymer Beitrag zum Ersparnis-Zähler: aus. Einschalten: steinwall telemetry on", "Anonymous contribution to the savings counter: off. Turn on: steinwall telemetry on");
}
function dashboard(args, _cfg, lang) {
    if (!proStatus().pro) {
        console.log(de(lang, "Das Dashboard mit Verlauf ist eine Pro-Funktion. Testphase oder Lizenz: steinwall license", "The dashboard with history is a Pro feature. Trial or license: steinwall license"));
        return 0;
    }
    const days = Number(args[args.indexOf("--days") + 1]) || 30;
    const out = writeDashboard(lang, days);
    if (!args.includes("--no-open"))
        openFile(out);
    console.log(out);
    return 0;
}
function card(args, _cfg, lang) {
    const out = writeCard(lang, args.includes("--month") ? 30 : 7);
    if (!args.includes("--no-open"))
        openFile(out);
    console.log(out);
    return 0;
}
function status(cfg, lang) {
    const day = loadDay(localDay());
    const b = evaluateBudget(cfg, day, monthCost(day.date.slice(0, 7)));
    const line = (label, spent, limit) => `${label.padEnd(12)} ≈ ${money(lang, spent)}${limit ? ` / ${money(lang, limit)} (${percent(lang, spent / limit)})` : ""}`;
    const plan = b.plan === "api" ? "API" : de(lang, "Abo (Kosten = API-Gegenwert)", "subscription (costs = API equivalent)");
    const stop = b.overridden
        ? de(lang, "für heute aufgehoben", "lifted for today")
        : b.enforced
            ? de(lang, "aktiv", "active")
            : de(lang, "aus (Abo: nur Warnungen)", "off (subscription: warnings only)");
    const models = Object.entries(day.byModel)
        .sort((a, c) => c[1] - a[1])
        .slice(0, 3)
        .map(([m, usd]) => `${m} ≈ ${money(lang, usd)}`)
        .join(", ");
    return [
        `SteinWall ${version()} · ${de(lang, "Plan", "Plan")}: ${plan}${cfg.plan === "auto" ? " (auto)" : ""}`,
        proLine(lang),
        line(de(lang, "Heute", "Today"), b.todayUsd, cfg.budget.dailyUsd),
        line(de(lang, "Monat", "This month"), b.monthUsd, cfg.budget.monthlyUsd),
        `${de(lang, "Budget-Stopp", "Budget stop")}: ${stop}`,
        `${de(lang, "Aktionsschutz heute", "Action guard today")}: ${day.guard.denied} ${de(lang, "blockiert", "blocked")}, ${day.guard.asked} ${de(lang, "zur Freigabe", "held for approval")}`,
        `${de(lang, "Schleifen-Rettung heute", "Loop rescue today")}: ${day.loops.hints} ${de(lang, "Hinweise", "hints")}, ${day.loops.blocks} ${de(lang, "Strategiewechsel", "strategy changes")}`,
        ...(models ? [`${de(lang, "Modelle heute", "Models today")}: ${models}`] : []),
        ...(day.unknownModels.length
            ? [de(lang, `Unbekannte Modelle (Sonnet-Preis angesetzt): ${day.unknownModels.join(", ")}`, `Unknown models (priced as Sonnet): ${day.unknownModels.join(", ")}`)]
            : []),
        de(lang, "Alle Beträge sind Schätzungen zu API-Listenpreisen.", "All amounts are estimates at API list prices."),
    ].join("\n");
}
function budget(args, cfg, lang) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        const value = args[i + 1];
        if (a === "override") {
            setTodayOverride(true);
            out.push(de(lang, "Budget-Stopp für heute aufgehoben. Ab morgen gilt er wieder.", "Budget stop lifted for today. It applies again from tomorrow."));
        }
        else if (a === "resume") {
            setTodayOverride(false);
            out.push(de(lang, "Budget-Stopp wieder aktiv.", "Budget stop active again."));
        }
        else if (a === "--daily" || a === "--monthly") {
            setConfigValue(cfg, a === "--daily" ? "budget.dailyUsd" : "budget.monthlyUsd", value ?? "");
            i++;
        }
        else if (a === "--plan") {
            if (value !== "api" && value !== "subscription" && value !== "auto")
                throw new Error("--plan must be api, subscription or auto");
            cfg.plan = value;
            i++;
        }
        else if (a === "--enforce-subscription") {
            cfg.budget.enforceOnSubscription = value === "on" || value === "true";
            i++;
        }
        else {
            throw new Error(`Unknown budget option: ${a}`);
        }
    }
    if (args.some((a) => a.startsWith("--"))) {
        saveConfig(cfg);
        out.push(de(lang, "Budget gespeichert.", "Budget saved."));
    }
    out.push(status(cfg, lang));
    return out.join("\n");
}
function check(command, cfg, lang) {
    const d = checkToolCall({ tool: "Bash", input: { command } }, cfg);
    if (!d)
        return de(lang, "erlaubt", "allowed");
    return `${d.decision.toUpperCase()}: ${ruleLabel(lang, d.rule)}`;
}
function formatScan(target, verdict, findings, lang, extra = "") {
    const label = lang === "de" ? { ok: "OK", warn: "AUFFÄLLIG", block: "NICHT INSTALLIEREN" } : { ok: "OK", warn: "SUSPICIOUS", block: "DO NOT INSTALL" };
    const shown = findings.filter((f) => f.severity !== "info" && (verdict !== "ok" || f.severity !== "low"));
    const lines = shown.map((f) => `  [${f.severity}] ${f.ruleId} – ${f.file}${f.line ? `:${f.line}` : ""}\n      ${f.excerpt}`);
    return [`${label[verdict].padEnd(18)} ${target}${extra}`, ...lines].join("\n");
}
function scan(args, cfg, lang) {
    const results = [];
    if (args.includes("--installed")) {
        for (const item of discover(process.cwd(), { desktop: cfg.scanner.includeDesktopPlugins })) {
            if (cfg.scanner.trusted.includes(item.name))
                continue;
            const r = scanItem(item);
            results.push({ target: `${item.name} (${item.kind})`, verdict: r.verdict, findings: r.findings });
        }
    }
    for (const path of args.filter((a) => !a.startsWith("--"))) {
        const r = scanPath(path);
        results.push({ target: path, verdict: r.verdict, findings: r.findings, extra: ` (${r.files} ${de(lang, "Dateien", "files")})` });
    }
    if (!results.length && args.includes("--installed")) {
        console.log(de(lang, "Keine installierten Erweiterungen gefunden (SteinWall selbst ausgenommen).", "No installed extensions found (SteinWall itself excluded)."));
        return 0;
    }
    if (!results.length) {
        console.log(de(lang, "Nichts zu prüfen. Pfad angeben oder --installed.", "Nothing to scan. Give a path or --installed."));
        return 1;
    }
    if (args.includes("--json"))
        console.log(JSON.stringify(results, null, 2));
    else {
        console.log(results.map((r) => formatScan(r.target, r.verdict, r.findings, lang, r.extra)).join("\n"));
        console.log(de(lang, "Regelbasierte Prüfung: Funde sind Hinweise, kein Beweis; ein OK ist keine Garantie.", "Rule-based check: findings are indicators, not proof; OK is not a guarantee."));
    }
    return results.some((r) => r.verdict === "block") ? 2 : 0;
}
// --- status line installation ------------------------------------------------
const LAUNCHER = `// Generated by SteinWall. Finds the installed plugin version and renders the status line.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const home = process.env.STEINWALL_HOME || join(homedir(), ".steinwall");
try {
  const root = readFileSync(join(home, "plugin-root"), "utf8").trim();
  await import(pathToFileURL(join(root, "dist", "bin", "statusline.js")).href);
} catch {
  process.stdout.write("SteinWall");
}
`;
const settingsFile = () => join(claudeConfigDir(), "settings.json");
const launcherCommand = () => `node "${statuslineLauncher().replace(/\\/g, "/")}"`;
const isOurs = (s) => !!s?.command && (s.command === launcherCommand() || /steinwall/i.test(s.command));
function loadSettings() {
    if (!existsSync(settingsFile()))
        return {};
    // Refuse to touch a settings file we cannot parse rather than overwrite it.
    return JSON.parse(readFileSync(settingsFile(), "utf8"));
}
function setupStatusline(force, lang) {
    mkdirSync(dirname(statuslineLauncher()), { recursive: true });
    writeFileSync(pluginRootFile(), pluginRoot());
    writeFileSync(statuslineLauncher(), LAUNCHER);
    const settings = loadSettings();
    if (settings.statusLine && !isOurs(settings.statusLine)) {
        if (!force) {
            return de(lang, `Es gibt schon eine Statuszeile (${settings.statusLine.command ?? "?"}). Nichts geändert. Mit --force ersetzen (die alte wird gesichert).`, `A status line is already configured (${settings.statusLine.command ?? "?"}). Nothing changed. Use --force to replace it (the old one is backed up).`);
        }
        writeJson(statuslineBackupFile(), settings.statusLine);
    }
    settings.statusLine = { type: "command", command: `node "${statuslineLauncher().replace(/\\/g, "/")}"`, padding: 0 };
    writeJson(settingsFile(), settings);
    return de(lang, `Statuszeile installiert (${settingsFile()}). Sie erscheint bei der nächsten Aktualisierung.`, `Status line installed (${settingsFile()}). It appears on the next refresh.`);
}
function removeStatusline(lang) {
    const settings = loadSettings();
    if (!isOurs(settings.statusLine))
        return de(lang, "SteinWall-Statuszeile ist nicht installiert.", "SteinWall status line is not installed.");
    const backup = readJson(statuslineBackupFile(), null);
    if (backup)
        settings.statusLine = backup;
    else
        delete settings.statusLine;
    writeJson(settingsFile(), settings);
    return de(lang, backup ? "Statuszeile entfernt, vorherige wiederhergestellt." : "Statuszeile entfernt.", backup ? "Status line removed, previous one restored." : "Status line removed.");
}
const HELP = `steinwall - guardian for coding agents. Spend less. Break nothing.

  status                         cost today/this month, budgets, guard counts
  report [--date YYYY-MM-DD]     daily report: cost, savings, blocked actions, rescued loops
  scan <path...> | --installed   check skills, plugins, MCP configs for malicious patterns
                                 (exit code 2 if something should not be installed)
  budget [options]               --daily <USD|off> --monthly <USD|off> --plan <api|subscription|auto>
                                 --enforce-subscription <on|off>, override (lift today's stop), resume
  license [activate <key>|refresh|deactivate]   Pro license and trial status
  telemetry on|off               anonymous contribution to the public savings counter (opt-in)
  dashboard [--days N] [--no-open]   Pro: local dashboard with history
  card [--month] [--no-open]     shareable savings card (PNG download)
  mcp                            run as MCP server (stdio): status, report, scan tools
  config                         print the config
  config set <key> <value>       e.g. config set guard.rules.force-push deny
  check <command>                dry-run the action guard on a shell command
  setup-statusline [--force]     install the Claude Code status line
  remove-statusline              uninstall it (restores the previous one)
`;
export function runCli(argv) {
    const cfg = loadConfig();
    const lang = resolveLanguage(cfg);
    const [cmd, ...args] = argv;
    try {
        switch (cmd) {
            case "scan":
                return scan(args, cfg, lang);
            case "report": {
                const i = args.indexOf("--date");
                const date = i >= 0 ? args[i + 1] : undefined;
                if (date !== undefined && !/^d{4}-d{2}-d{2}$/.test(date))
                    throw new Error("--date expects YYYY-MM-DD");
                console.log(buildReport(cfg, lang, date));
                return 0;
            }
            case "status":
                console.log(status(cfg, lang));
                return 0;
            case "budget":
                console.log(budget(args, cfg, lang));
                return 0;
            case "license":
                return license(args, cfg, lang);
            case "mcp":
                runMcpServer();
                return 0;
            case "background":
                void runBackground(cfg).then((r) => args.includes("--verbose") && console.log(JSON.stringify(r)));
                return 0;
            case "dashboard":
                return dashboard(args, cfg, lang);
            case "card":
                return card(args, cfg, lang);
            case "telemetry":
                console.log(telemetry(args[0], cfg, lang));
                return 0;
            case "config":
                if (args[0] === "set" && args[1] && args[2] !== undefined) {
                    saveConfig(setConfigValue(cfg, args[1], args.slice(2).join(" ")));
                }
                console.log(JSON.stringify(cfg, null, 2));
                return 0;
            case "check":
                console.log(check(args.join(" "), cfg, lang));
                return 0;
            case "setup-statusline":
                console.log(setupStatusline(args.includes("--force"), lang));
                return 0;
            case "remove-statusline":
                console.log(removeStatusline(lang));
                return 0;
            case "statusline":
                void runStatusline();
                return 0;
            case undefined:
            case "help":
            case "--help":
            case "-h":
                console.log(HELP);
                return 0;
            default:
                console.error(`Unknown command: ${cmd}\n\n${HELP}`);
                return 1;
        }
    }
    catch (err) {
        console.error(`steinwall: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
    }
}
// Leave the exit code alone for long-running commands (mcp server).
const code = runCli(process.argv.slice(2));
if (process.argv[2] !== "mcp")
    process.exitCode = code;
