/**
 * Pro features that work through the hooks:
 *  - routing: SteinWall ships a "scout" subagent on a cheap model for read-only work. When it
 *    finishes, its real token usage is priced at the main model and at its own model; the
 *    difference is credited as savings.
 *  - context advisor: tells the user when the context makes every request expensive.
 *  - output trimming (Codex): shortens huge tool outputs before they enter the context.
 *  - cost coach (test feature, off by default): estimates the cost of a prompt.
 *  - cross-tool handoff: points to the other agent when a limit is reached.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { money } from "./i18n.js";
import { readJson } from "./fsutil.js";
import { claudeConfigDir } from "./paths.js";
import { costUsd, priceFor } from "./pricing.js";
import { codexHome } from "./scanner/inventory.js";
// --- routing ---------------------------------------------------------------------------------
export const SCOUT_MARKER = "[steinwall-scout]";
export function isScout(agentType, transcriptText) {
    return /steinwall.*scout|scout.*steinwall/i.test(agentType ?? "") || transcriptText.includes(SCOUT_MARKER);
}
/** Real cost of a subagent transcript, and what the same tokens would have cost on `mainModel`. */
export function routingSavings(transcriptText, mainModel) {
    const seen = new Map();
    for (const line of transcriptText.split("\n")) {
        if (!line.includes('"usage"'))
            continue;
        try {
            const e = JSON.parse(line);
            const m = e.message;
            if (e.type !== "assistant" || !m?.usage || !m.model || m.model === "<synthetic>")
                continue;
            const u = m.usage;
            seen.set(m.id ?? String(seen.size), {
                model: m.model,
                usage: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite5m: u.cache_creation_input_tokens ?? 0, cacheWrite1h: 0 },
            });
        }
        catch {
            // partial line
        }
    }
    let actual = 0;
    let onMain = 0;
    let model;
    for (const { model: m, usage } of seen.values()) {
        model = m;
        actual += costUsd(m, usage);
        onMain += costUsd(mainModel, usage);
    }
    return { actual, onMain, saved: Math.max(0, onMain - actual), ...(model ? { model } : {}) };
}
/** Worth suggesting the scout only when the main model is clearly more expensive than the scout's. */
export function routingWorthwhile(mainModel) {
    if (!mainModel)
        return false;
    const main = priceFor(mainModel).price;
    return main.input >= 1.9 && /claude/i.test(mainModel);
}
export function routingHint(lang) {
    return lang === "de"
        ? "SteinWall Pro: Für breites Suchen und Lesen (Dateien finden, Code durchsuchen, Doku oder Logs zusammenfassen) delegiere an den Subagenten `steinwall:scout`. Er läuft auf einem günstigeren Modell. Entscheidungen und Änderungen machst du selbst."
        : "SteinWall Pro: For broad searching and reading (finding files, searching code, summarizing docs or logs), delegate to the `steinwall:scout` subagent. It runs on a cheaper model. Decisions and edits stay with you.";
}
// --- context advisor -------------------------------------------------------------------------
/** One message per 50K tokens of growth above the threshold. */
export function contextLevel(tokens, threshold) {
    return tokens < threshold ? 0 : 1 + Math.floor((tokens - threshold) / 50_000);
}
export function contextAdvice(lang, model, tokens, agent, focus) {
    const p = priceFor(model).price;
    const cached = (tokens * (p.cacheRead ?? p.input * 0.1)) / 1e6;
    const uncached = (tokens * p.input) / 1e6;
    const k = Math.round(tokens / 1000);
    const hint = focus ? ` ${lang === "de" ? "z. B." : "e.g."} \`/compact ${lang === "de" ? "Fokus" : "focus"}: ${focus.slice(0, 60)}\`` : "";
    const tool = agent === "codex" ? "/compact" : "/compact";
    return lang === "de"
        ? `SteinWall Pro: Der Kontext ist auf ≈ ${k}K Tokens gewachsen. Jede weitere Anfrage kostet allein dafür ≈ ${money(lang, cached)} (aus dem Cache) bis ${money(lang, uncached)}. Mit \`${tool}\` und einem Fokus wird er kleiner.${hint}`
        : `SteinWall Pro: The context has grown to ≈ ${k}K tokens. Every further request costs ≈ ${money(lang, cached)} (cached) to ${money(lang, uncached)} for it alone. \`${tool}\` with a focus makes it smaller.${hint}`;
}
// --- output trimming (Codex) ---------------------------------------------------------------------
export function trimOutput(text, maxChars, lang) {
    if (text.length <= maxChars)
        return null;
    const head = Math.floor(maxChars * 0.6);
    const tail = Math.floor(maxChars * 0.3);
    const removed = text.length - head - tail;
    const note = lang === "de"
        ? `\n\n… [SteinWall: ${removed.toLocaleString("de-DE")} Zeichen in der Mitte gekürzt, um Kontext zu sparen. Brauchst du sie, filtere gezielter (grep, head, tail, sed -n).] …\n\n`
        : `\n\n… [SteinWall: ${removed.toLocaleString("en-US")} characters in the middle trimmed to save context. If you need them, filter more narrowly (grep, head, tail, sed -n).] …\n\n`;
    return { text: text.slice(0, head) + note + text.slice(text.length - tail), removed };
}
/** Removed characters as tokens (≈ 4 chars each), priced once at the model's input price: a lower bound. */
export function trimSavings(removedChars, model) {
    return ((removedChars / 4) * priceFor(model).price.input) / 1e6;
}
// --- cost coach ---------------------------------------------------------------------------------
export function costCoach(lang, model, contextTokens, prompt) {
    const p = priceFor(model).price;
    const promptTokens = Math.ceil(prompt.length / 4);
    const typicalOutput = 1500;
    const est = (contextTokens * (p.cacheRead ?? p.input * 0.1) + promptTokens * p.input + typicalOutput * p.output) / 1e6;
    const tips = [];
    if (prompt.length > 6000)
        tips.push(lang === "de" ? "Langer Text: als Datei ablegen und darauf verweisen spart Tokens bei jeder Folgeanfrage." : "Long text: saving it to a file and referring to it saves tokens on every follow-up request.");
    if (/\b(whole|entire|all) (code ?base|repo|project|files)\b|\b(gesamte[nr]?|ganze[nr]?) (code ?base|repo|projekt)|alle dateien/i.test(prompt)) {
        tips.push(lang === "de" ? "„Alles lesen“ ist teuer: nenne die relevanten Ordner oder Dateien." : "'Read everything' is expensive: name the relevant folders or files.");
    }
    const head = lang === "de" ? `Kosten-Coach: diese Anfrage ≈ ${money(lang, est)} (Kontext ≈ ${Math.round(contextTokens / 1000)}K Tokens).` : `Cost coach: this request ≈ ${money(lang, est)} (context ≈ ${Math.round(contextTokens / 1000)}K tokens).`;
    return [head, ...tips].join(" ");
}
// --- cross-tool handoff ---------------------------------------------------------------------------
/** Is SteinWall installed in the other agent, so it would load the handoff file? */
export function otherAgentWithSteinwall(agent) {
    if (agent === "claude") {
        const cache = join(codexHome(), "plugins", "cache");
        try {
            for (const market of readdirSync(cache))
                if (existsSync(join(cache, market, "steinwall")))
                    return "codex";
        }
        catch {
            // no Codex
        }
        return null;
    }
    const installed = readJson(join(claudeConfigDir(), "plugins", "installed_plugins.json"), {});
    return Object.keys(installed.plugins ?? {}).some((id) => id.startsWith("steinwall@")) ? "claude" : null;
}
export function crossToolHint(lang, other) {
    const cmd = other === "codex" ? "codex" : "claude";
    const name = other === "codex" ? "Codex" : "Claude Code";
    return lang === "de"
        ? ` SteinWall Pro: Du kannst sofort mit ${name} weitermachen – im Projektordner \`${cmd}\` starten, die Übergabe wird automatisch geladen.`
        : ` SteinWall Pro: You can continue right away in ${name} – start \`${cmd}\` in the project folder and the handoff is loaded automatically.`;
}
export function readTextSafe(path) {
    if (!path)
        return "";
    try {
        return readFileSync(path, "utf8");
    }
    catch {
        return "";
    }
}
