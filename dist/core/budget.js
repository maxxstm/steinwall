import { resolvePlan } from "./config.js";
function limit(kind, limitUsd, spentUsd, warnAt) {
    if (limitUsd === null || limitUsd <= 0)
        return null;
    const ratio = spentUsd / limitUsd;
    const state = ratio >= 1 ? "exceeded" : ratio >= warnAt ? "warn" : "ok";
    return { kind, limitUsd, spentUsd, ratio, state };
}
export function evaluateBudget(cfg, today, monthUsd, env = process.env) {
    const plan = resolvePlan(cfg, env);
    const daily = limit("daily", cfg.budget.dailyUsd, today.costUsd, cfg.budget.warnAt);
    const monthly = limit("monthly", cfg.budget.monthlyUsd, monthUsd, cfg.budget.warnAt);
    const candidates = [daily, monthly].filter((l) => l !== null && l.state !== "ok");
    const worst = candidates.find((l) => l.state === "exceeded") ?? candidates.sort((a, b) => b.ratio - a.ratio)[0] ?? null;
    const overridden = today.flags.override === true;
    return {
        plan,
        enforced: (plan === "api" || cfg.budget.enforceOnSubscription) && !overridden,
        overridden,
        todayUsd: today.costUsd,
        monthUsd,
        daily,
        monthly,
        worst,
    };
}
