/**
 * Work that needs the network runs in a detached process, never inside a hook: the license
 * refresh (every few days) and, only with the user's consent, sending yesterday's savings to the
 * public counter. At most once per day.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { type Config, type Language } from "../../core/config.js";
import { localDay, readJson, writeJson } from "../../core/fsutil.js";
import { installInfo, refreshDue, refreshLicense } from "../../core/license.js";
import { stateDir } from "../../core/paths.js";
import { loadDay } from "../../core/usage.js";
import { pluginRoot } from "./io.js";

const backgroundFile = () => join(stateDir(), "background.json");
const telemetryFile = () => join(stateDir(), "telemetry.json");

export function backgroundTasks(cfg: Config, now = new Date()): void {
  if (!cfg.license.apiUrl) return; // no backend configured: nothing to do online
  if (!refreshDue(now.getTime()) && !cfg.telemetry.enabled) return;
  const state = readJson<{ lastRun?: string }>(backgroundFile(), {});
  if (state.lastRun === localDay(now)) return;
  writeJson(backgroundFile(), { lastRun: localDay(now) });
  const child = spawn(process.execPath, [join(pluginRoot(), "dist", "cli.js"), "background"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

/** Run by `steinwall background` in the detached process. */
export async function runBackground(cfg: Config, fetchImpl: typeof fetch = fetch, now = new Date()): Promise<{ sentDays: string[]; license: string }> {
  const sentDays: string[] = [];
  if (cfg.telemetry.enabled && cfg.license.apiUrl) {
    const state = readJson<{ sent?: string[] }>(telemetryFile(), {});
    const sent = new Set(state.sent ?? []);
    const { installId } = installInfo(now.getTime());
    // The last seven finished days (never today, which is still changing).
    for (let i = 7; i >= 1; i--) {
      const day = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
      if (sent.has(day)) continue;
      const savedUsd = Math.round(loadDay(day).savings.usd * 100) / 100;
      try {
        const res = await fetchImpl(`${cfg.license.apiUrl.replace(/\/$/, "")}/telemetry`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ installId, day, savedUsd }),
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          sent.add(day);
          sentDays.push(day);
        }
      } catch {
        break; // offline: try again another day
      }
    }
    writeJson(telemetryFile(), { sent: [...sent].sort().slice(-30) });
  }
  const license = refreshDue(now.getTime()) ? await refreshLicense(cfg.license.apiUrl, fetchImpl) : "not due";
  return { sentDays, license };
}

/**
 * The opt-in question, once, at the first session start. Not pre-selected: doing nothing keeps
 * telemetry off.
 */
export function telemetryQuestionOnce(cfg: Config, lang: Language): string | null {
  if (cfg.telemetry.asked) return null;
  const state = readJson<{ questionShown?: boolean }>(telemetryFile(), {});
  if (state.questionShown) return null;
  writeJson(telemetryFile(), { ...state, questionShown: true });
  return lang === "de"
    ? "SteinWall: Möchtest du deine geschätzte Tagesersparnis anonym zum öffentlichen Zähler beitragen? Übertragen werden nur eine Zahl pro Tag und eine zufällige Installations-ID, keine Prompts, kein Code, keine Pfade. Ja: `/steinwall:telemetry on`. Nein: nichts tun, es bleibt aus. Jederzeit änderbar."
    : "SteinWall: Would you like to contribute your estimated daily savings anonymously to the public counter? Only one number per day and a random install id are sent: no prompts, code or paths. Yes: `/steinwall:telemetry on`. No: do nothing, it stays off. You can change this any time.";
}
