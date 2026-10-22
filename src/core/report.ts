/**
 * Daily report: costs, savings, blocked actions, rescued loops. All amounts are estimates at API
 * list prices and are shown with "≈"; the method is documented in the README
 * ("How savings are calculated").
 */
import { join } from "node:path";
import { type Config, type Language, resolvePlan } from "./config.js";
import { localDay, readJson, writeJson } from "./fsutil.js";
import { loadRateLimits } from "./handoff.js";
import { money, percent } from "./i18n.js";
import { stateDir } from "./paths.js";
import { loadDay, monthCost, type DayUsage } from "./usage.js";
import { proStatus } from "./license.js";

const HOUR = 3600 * 1000;
const limitValueFile = () => join(stateDir(), "limit-value.json");
/** A cached limit value stays usable this long without fresh status line data. */
const LIMIT_VALUE_MAX_AGE_MS = 14 * 24 * HOUR;

/**
 * What a full 5-hour limit is worth at API list prices: the cost accounted in the current window
 * divided by the share of the limit Claude Code reports as used. Needs the status line's limit data;
 * the last good value is cached so the report works later too.
 */
export function fiveHourLimitUsd(now = Date.now()): number | null {
  const window = loadRateLimits(now)?.windows.five_hour;
  if (window?.resetsAt && window.usedPercentage >= 5) {
    const start = new Date(window.resetsAt).getTime() - 5 * HOUR;
    let cost = 0;
    for (let t = start - (start % HOUR); t <= now; t += HOUR) {
      const d = new Date(t);
      cost += loadDay(localDay(d)).byHour[String(d.getHours())] ?? 0;
    }
    if (cost > 0) {
      const usd = cost / (window.usedPercentage / 100);
      writeJson(limitValueFile(), { fiveHourUsd: usd, at: now });
      return usd;
    }
  }
  const cached = readJson<{ fiveHourUsd: number; at: number } | null>(limitValueFile(), null);
  return cached && now - cached.at <= LIMIT_VALUE_MAX_AGE_MS ? cached.fiveHourUsd : null;
}

/** "≈ 1,80 $" or, for subscription users when the limit value is known, "≈ 6 % eines 5-Stunden-Limits". */
export function savingsLabel(cfg: Config, lang: Language, usd: number, limitUsd = fiveHourLimitUsd()): string {
  const amount = `≈ ${money(lang, usd)}`;
  if (resolvePlan(cfg) !== "subscription" || !limitUsd) return amount;
  const share = percent(lang, usd / limitUsd);
  return `${amount} · ≈ ${share} ${lang === "de" ? "eines 5-Stunden-Limits" : "of a 5-hour limit"}`;
}

function lastDays(end: string, n: number): DayUsage[] {
  const [y, m, d] = end.split("-").map(Number) as [number, number, number];
  return Array.from({ length: n }, (_, i) => loadDay(localDay(new Date(y, m - 1, d - i))));
}

export function buildReport(cfg: Config, lang: Language, date = localDay()): string {
  const de = lang === "de";
  const day = loadDay(date);
  const plan = resolvePlan(cfg);
  const fmtDate = new Date(`${date}T12:00:00`).toLocaleDateString(de ? "de-DE" : "en-US", { weekday: "short", day: "2-digit", month: "2-digit", year: "numeric" });
  const row = (label: string, value: string) => `${label.padEnd(12)}${value}`;

  const budget = cfg.budget.dailyUsd ? ` · ${de ? "Tagesbudget" : "daily budget"} ${money(lang, cfg.budget.dailyUsd)} (${percent(lang, day.costUsd / cfg.budget.dailyUsd)})` : "";
  const costNote = plan === "subscription" ? (de ? " (API-Gegenwert)" : " (API equivalent)") : "";
  const week = lastDays(date, 7);
  const weekCost = week.reduce((s, d) => s + d.costUsd, 0);
  const weekSaved = week.reduce((s, d) => s + d.savings.usd, 0);
  const models = Object.entries(day.byModel)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([m, usd]) => `${m} ≈ ${money(lang, usd)}`)
    .join(" · ");

  const lines = [
    `SteinWall · ${de ? "Tagesbericht" : "Daily report"} ${fmtDate}`,
    row(de ? "Kosten" : "Cost", `≈ ${money(lang, day.costUsd)}${costNote}${budget}`),
    row(de ? "Ersparnis" : "Saved", day.savings.usd > 0 ? savingsLabel(cfg, lang, day.savings.usd) : de ? "–" : "–"),
  ];
  if (day.savings.loopsRescued > 0) {
    lines.push(row("", de ? `${day.savings.loopsRescued} Schleife(n) gerettet` : `${day.savings.loopsRescued} loop(s) rescued`));
  }
  const proToday = (day.savings.bySource?.routing ?? 0) + (day.savings.bySource?.trim ?? 0);
  if (proToday > 0) lines.push(row("", de ? `davon Pro (Routing, gekürzte Ausgaben): ≈ ${money(lang, proToday)}` : `of which Pro (routing, trimmed output): ≈ ${money(lang, proToday)}`));
  const upgrade = upgradeLine(lang, date);
  if (upgrade) lines.push(row("", upgrade));
  lines.push(
    row(de ? "Schutz" : "Guard", de ? `${day.guard.denied} blockiert, ${day.guard.asked} zur Freigabe` : `${day.guard.denied} blocked, ${day.guard.asked} held for approval`),
    row(de ? "Schleifen" : "Loops", de ? `${day.loops.hints} Hinweise, ${day.loops.blocks} Strategiewechsel` : `${day.loops.hints} hints, ${day.loops.blocks} strategy changes`),
  );
  if (day.scans.items > 0) {
    lines.push(row(de ? "Erweiterungen" : "Extensions", de ? `${day.scans.items} geprüft, ${day.scans.flagged} auffällig, ${day.scans.blocked} blockiert` : `${day.scans.items} scanned, ${day.scans.flagged} flagged, ${day.scans.blocked} blocked`));
  }
  if (day.handoffs > 0) lines.push(row(de ? "Übergaben" : "Handoffs", String(day.handoffs)));
  if (models) lines.push(row(de ? "Modelle" : "Models", models));
  lines.push(
    row(de ? "7 Tage" : "7 days", `${de ? "Kosten" : "cost"} ≈ ${money(lang, weekCost)} · ${de ? "Ersparnis" : "saved"} ≈ ${money(lang, weekSaved)}`),
    row(de ? "Monat" : "Month", `≈ ${money(lang, monthCost(date.slice(0, 7)))}`),
    de
      ? "Alle Beträge sind Schätzungen zu API-Listenpreisen. Rechenweg: README, Abschnitt \"How savings are calculated\"."
      : "All amounts are estimates at API list prices. Method: README, section \"How savings are calculated\".",
  );
  return lines.join("\n");
}

/**
 * The only upgrade hint: in the report, right under the savings, and only with a measured number:
 * what the Pro features saved in this user's own trial. Never shown to Pro users, never a forecast.
 */
/** What the Pro features (routing, trimmed output) saved in the last `days` days up to `date`. */
export function proSavedRecently(date: string, days = 30): number {
  return lastDays(date, days).reduce((s, d) => s + (d.savings.bySource?.routing ?? 0) + (d.savings.bySource?.trim ?? 0), 0);
}

export function upgradeLine(lang: Language, date: string, status = proStatus()): string | null {
  if (status.reason === "license" || status.reason === "grace") return null;
  const proSaved = proSavedRecently(date);
  if (proSaved < 0.01) return null;
  if (status.reason === "trial") {
    return lang === "de"
      ? `Pro-Testphase (noch ${status.trialDaysLeft} Tag(e)): Pro hat bisher ≈ ${money(lang, proSaved)} zusätzlich gespart.`
      : `Pro trial (${status.trialDaysLeft} day(s) left): Pro has saved an extra ≈ ${money(lang, proSaved)} so far.`;
  }
  return lang === "de"
    ? `In deiner Testphase hat Pro ≈ ${money(lang, proSaved)} zusätzlich gespart. Pro: 9 $/Monat – steinwall license`
    : `During your trial, Pro saved an extra ≈ ${money(lang, proSaved)}. Pro: $9/month – steinwall license`;
}

/** One line about a past day for the first session of a new day, or null if there is nothing to say. */
export function shortSummary(cfg: Config, lang: Language, date: string): string | null {
  const day = loadDay(date);
  if (day.costUsd <= 0 && day.guard.denied + day.guard.asked === 0) return null;
  const de = lang === "de";
  const parts = [`≈ ${money(lang, day.costUsd)} ${de ? "Kosten" : "cost"}`];
  if (day.savings.usd > 0) {
    parts.push(`${savingsLabel(cfg, lang, day.savings.usd)} ${de ? "gespart" : "saved"} (${day.savings.loopsRescued} ${de ? "Schleifen gerettet" : "loops rescued"})`);
  }
  const blocked = day.guard.denied + day.guard.asked;
  if (blocked > 0) parts.push(`${blocked} ${de ? "Aktionen abgefangen" : "actions intercepted"}`);
  return `SteinWall ${de ? "gestern" : "yesterday"}: ${parts.join(" · ")}. ${de ? "Details" : "Details"}: /steinwall:report --date ${date}`;
}

const trialNoticeFile = () => join(stateDir(), "trial-notice.json");

/**
 * The end of the trial, said twice at most: on the last trial day and at the first session after
 * it. With the measured Pro savings when there are any, otherwise one neutral line. Never for
 * license holders. Call only while holding the state lock.
 */
export function trialNoticeOnce(lang: Language, now = new Date(), status = proStatus(now.getTime())): string | null {
  if (status.reason === "license" || status.reason === "grace") return null;
  const shown = readJson<{ ending?: boolean; ended?: boolean }>(trialNoticeFile(), {});
  const de = lang === "de";
  const saved = proSavedRecently(localDay(now));
  const amount = saved >= 0.01 ? money(lang, saved) : null;
  if (status.reason === "trial" && status.trialDaysLeft === 1 && !shown.ending) {
    writeJson(trialNoticeFile(), { ...shown, ending: true });
    if (amount) {
      return de
        ? `SteinWall Pro: Die Testphase endet morgen. Pro hat bisher ≈ ${amount} zusätzlich gespart (günstigere Subagenten, gekürzte Ausgaben). Pro behalten: steinwall license`
        : `SteinWall Pro: your trial ends tomorrow. Pro has saved an extra ≈ ${amount} so far (cheaper subagents, trimmed output). Keep Pro: steinwall license`;
    }
    return de ? "SteinWall Pro: Die Testphase endet morgen. Pro behalten: steinwall license" : "SteinWall Pro: your trial ends tomorrow. Keep Pro: steinwall license";
  }
  if (status.reason === "none" && !shown.ended) {
    writeJson(trialNoticeFile(), { ending: true, ended: true });
    const free = de ? "Kostenbremse, Aktionsschutz, Schleifen-Rettung und Scanner bleiben kostenlos." : "Cost brake, action guard, loop rescue and the scanner stay free.";
    if (amount) {
      return de
        ? `SteinWall Pro: Die Testphase ist vorbei. Pro hat darin ≈ ${amount} zusätzlich gespart. ${free} Pro: 9 $/Monat – steinwall license`
        : `SteinWall Pro: your trial has ended. Pro saved an extra ≈ ${amount} during it. ${free} Pro: $9/month – steinwall license`;
    }
    return de ? `SteinWall Pro: Die Testphase ist vorbei. ${free} Details: steinwall license` : `SteinWall Pro: your trial has ended. ${free} Details: steinwall license`;
  }
  return null;
}

const reportShownFile = () => join(stateDir(), "report-shown.json");

/** Yesterday's summary, once per day. Call only while holding the state lock. */
export function dailySummaryOnce(cfg: Config, lang: Language, now = new Date()): string | null {
  const today = localDay(now);
  if (readJson<{ date?: string }>(reportShownFile(), {}).date === today) return null;
  writeJson(reportShownFile(), { date: today });
  const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  return shortSummary(cfg, lang, yesterday);
}
