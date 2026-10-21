import { type Config, type Plan, resolvePlan } from "./config.js";
import type { DayUsage } from "./usage.js";

export type LimitState = "ok" | "warn" | "exceeded";

export interface LimitStatus {
  kind: "daily" | "monthly";
  limitUsd: number;
  spentUsd: number;
  ratio: number;
  state: LimitState;
}

export interface BudgetStatus {
  plan: Plan;
  /** Whether reaching a limit actually stops the agent. */
  enforced: boolean;
  overridden: boolean;
  todayUsd: number;
  monthUsd: number;
  daily: LimitStatus | null;
  monthly: LimitStatus | null;
  /** The limit to talk about: an exceeded one first, otherwise the closest warning. */
  worst: LimitStatus | null;
}

function limit(kind: LimitStatus["kind"], limitUsd: number | null, spentUsd: number, warnAt: number): LimitStatus | null {
  if (limitUsd === null || limitUsd <= 0) return null;
  const ratio = spentUsd / limitUsd;
  const state: LimitState = ratio >= 1 ? "exceeded" : ratio >= warnAt ? "warn" : "ok";
  return { kind, limitUsd, spentUsd, ratio, state };
}

export function evaluateBudget(cfg: Config, today: DayUsage, monthUsd: number, env: NodeJS.ProcessEnv = process.env): BudgetStatus {
  const plan = resolvePlan(cfg, env);
  const daily = limit("daily", cfg.budget.dailyUsd, today.costUsd, cfg.budget.warnAt);
  const monthly = limit("monthly", cfg.budget.monthlyUsd, monthUsd, cfg.budget.warnAt);
  const candidates = [daily, monthly].filter((l): l is LimitStatus => l !== null && l.state !== "ok");
  const worst =
    candidates.find((l) => l.state === "exceeded") ?? candidates.sort((a, b) => b.ratio - a.ratio)[0] ?? null;
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
