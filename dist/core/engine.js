import { dailySummaryOnce } from "./report.js";
import { saveCodexRateLimits } from "./handoff.js";
import { checkInventory } from "./scanner/inventory.js";
import { evaluateBudget } from "./budget.js";
import { localDay, withLock } from "./fsutil.js";
import { ingestSession, loadDay, monthCost, updateDay } from "./usage.js";
import { loadSession, saveSession } from "./session.js";
/**
 * Account new transcript usage, then evaluate the budget. Shared by all agent adapters.
 * With `notify`, a newly reached warn/exceeded state is returned once per day and limit.
 */
export function refresh(cfg, session = {}, opts = {}) {
    return withLock(() => {
        const { limitHit, codexRateLimits, mainModel, contextTokens } = ingestSession(session.transcriptPath, session.sessionId ?? "unknown");
        if (codexRateLimits)
            saveCodexRateLimits(codexRateLimits);
        const today = localDay();
        let day = loadDay(today);
        const budget = evaluateBudget(cfg, day, monthCost(today.slice(0, 7)));
        let announce = null;
        const worst = budget.worst;
        if (opts.notify && worst) {
            const flag = worst.kind === "daily" ? "notifiedDaily" : "notifiedMonthly";
            if (day.flags[flag] !== worst.state && day.flags[flag] !== "exceeded") {
                announce = worst;
                day = updateDay(today, (d) => {
                    d.flags[flag] = worst.state;
                });
            }
        }
        return { day, budget, announce, limitHit, ...(mainModel ? { mainModel } : {}), ...(contextTokens ? { contextTokens } : {}) };
    });
}
/** Read-modify-write one session's state under the lock. */
export function withSession(sessionId, fn) {
    return withLock(() => {
        const state = loadSession(sessionId ?? "unknown");
        const result = fn(state);
        saveSession(state);
        return result;
    });
}
/** Change today's usage record under the lock. */
export function updateToday(fn) {
    withLock(() => updateDay(localDay(), fn));
}
export function creditSavings(rescue) {
    if (rescue.loops === 0)
        return;
    updateToday((d) => {
        d.savings.usd += rescue.usd;
        d.savings.loopsRescued += rescue.loops;
        d.savings.bySource = { ...d.savings.bySource, loops: (d.savings.bySource?.loops ?? 0) + rescue.usd };
    });
}
/** Savings from a Pro feature (measured by the feature itself). */
export function creditProSavings(source, usd) {
    if (!(usd > 0))
        return;
    updateToday((d) => {
        d.savings.usd += usd;
        d.savings.bySource = { ...d.savings.bySource, [source]: (d.savings.bySource?.[source] ?? 0) + usd };
    });
}
export function recordLoopEvent(level) {
    withLock(() => updateDay(localDay(), (d) => {
        if (level >= 2)
            d.loops.blocks++;
        else
            d.loops.hints++;
    }));
}
export function recordGuardDecision(decision) {
    withLock(() => updateDay(localDay(), (d) => {
        if (decision === "deny")
            d.guard.denied++;
        else
            d.guard.asked++;
    }));
}
export function setTodayOverride(on) {
    withLock(() => updateDay(localDay(), (d) => {
        d.flags.override = on;
    }));
}
/** Yesterday's one-line summary, at most once per day. */
export function dailySummary(cfg, lang) {
    return withLock(() => dailySummaryOnce(cfg, lang));
}
/** Scan new or changed extensions and count the results for the report. */
export function checkExtensions(cwd, scanner) {
    return withLock(() => {
        const result = checkInventory(cwd, scanner.trusted, { desktop: scanner.includeDesktopPlugins });
        if (result.scanned) {
            updateDay(localDay(), (d) => {
                d.scans.items += result.scanned;
                d.scans.flagged += result.flagged.length;
            });
        }
        return result;
    });
}
export function recordScan(verdict) {
    updateToday((d) => {
        d.scans.items++;
        if (verdict !== "ok")
            d.scans.flagged++;
        if (verdict === "block")
            d.scans.blocked++;
    });
}
