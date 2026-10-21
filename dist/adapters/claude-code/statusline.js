/**
 * Claude Code status line: `SteinWall · Heute ≈ 3,20 $ / 25 $ · Monat ≈ 41 $ / 300 $ · 1 blockiert · 5h 42 %`.
 * Claude Code pipes session JSON on stdin and shows the first line we print.
 */
import { loadConfig, resolveLanguage, resolvePlan } from "../../core/config.js";
import { refresh } from "../../core/engine.js";
import { localDay, logError } from "../../core/fsutil.js";
import { money, percent } from "../../core/i18n.js";
import { evaluateBudget } from "../../core/budget.js";
import { loadDay, monthCost } from "../../core/usage.js";
import { saveRateLimits } from "../../core/handoff.js";
import { fiveHourLimitUsd } from "../../core/report.js";
import { readStdin } from "./io.js";
const COLOR = { warn: "\x1b[33m", exceeded: "\x1b[31m", reset: "\x1b[0m" };
export function renderStatusline(snap, input, lang, color = true, saved = null) {
    const { budget, day } = snap;
    const paint = (text, l) => color && l && l.state !== "ok" ? `${COLOR[l.state]}${text}${COLOR.reset}` : text;
    const amount = (spent, l) => `≈ ${money(lang, spent)}${l ? ` / ${money(lang, l.limitUsd)}` : ""}`;
    const parts = ["SteinWall"];
    parts.push(paint(`${lang === "de" ? "Heute" : "Today"} ${amount(budget.todayUsd, budget.daily)}`, budget.daily));
    parts.push(paint(`${lang === "de" ? "Monat" : "Month"} ${amount(budget.monthUsd, budget.monthly)}`, budget.monthly));
    if (budget.enforced && budget.worst?.state === "exceeded") {
        parts.push(paint(lang === "de" ? "STOPP: Budget erreicht" : "STOP: budget reached", budget.worst));
    }
    if (saved)
        parts.push(`${lang === "de" ? "gespart" : "saved"} ${saved}`);
    const blocked = day.guard.denied + day.guard.asked;
    if (blocked > 0)
        parts.push(`${blocked} ${lang === "de" ? "blockiert" : "blocked"}`);
    const limits = input.rate_limits ?? {};
    for (const [key, label] of [["five_hour", "5h"], ["seven_day", "7d"]]) {
        const used = limits[key]?.used_percentage;
        if (typeof used === "number")
            parts.push(`${label} ${percent(lang, used / 100)}`);
    }
    return parts.join(" · ");
}
function fallbackSnapshot(cfg) {
    const day = loadDay(localDay());
    return { day, budget: evaluateBudget(cfg, day, monthCost(day.date.slice(0, 7))), announce: null, limitHit: false };
}
export async function runStatusline() {
    let input = {};
    try {
        const raw = await readStdin();
        if (raw.trim())
            input = JSON.parse(raw);
    }
    catch (err) {
        logError("statusline", err);
    }
    const cfg = loadConfig();
    const lang = resolveLanguage(cfg);
    try {
        // Only the status line receives limit data; the hooks read it from there for the handoff.
        saveRateLimits(input.rate_limits);
        fiveHourLimitUsd(); // refresh the cached value of a full 5-hour limit for savings in %
    }
    catch (err) {
        logError("statusline", err);
    }
    let snap;
    try {
        snap = refresh(cfg, { transcriptPath: input.transcript_path, sessionId: input.session_id });
    }
    catch (err) {
        logError("statusline", err);
        snap = fallbackSnapshot(cfg);
    }
    const saved = snap.day.savings.usd > 0 ? statusSavings(cfg, lang, snap.day.savings.usd) : null;
    process.stdout.write(renderStatusline(snap, input, lang, !process.env.NO_COLOR, saved));
}
/** Compact savings for the status line: "≈ 6 % Limit" for subscription users when known, else "≈ 1,80 $". */
function statusSavings(cfg, lang, usd) {
    const limitUsd = resolvePlan(cfg) === "subscription" ? fiveHourLimitUsd() : null;
    return limitUsd ? `≈ ${percent(lang, usd / limitUsd)} ${lang === "de" ? "5h-Limit" : "of 5h limit"}` : `≈ ${money(lang, usd)}`;
}
