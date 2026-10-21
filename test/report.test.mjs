import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "sw-report-"));
process.env.STEINWALL_HOME = home;
const { recordAttempt, recordFailure, settleRescues } = await import("../dist/core/loops.js");
const { emptySession } = await import("../dist/core/session.js");
const { DEFAULT_CONFIG } = await import("../dist/core/config.js");
const { buildReport, shortSummary, savingsLabel, fiveHourLimitUsd, dailySummaryOnce } = await import("../dist/core/report.js");
const { saveRateLimits } = await import("../dist/core/handoff.js");
const { emptyDay } = await import("../dist/core/usage.js");
const { localDay } = await import("../dist/core/fsutil.js");

const cfg = structuredClone(DEFAULT_CONFIG);
const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const build = { tool: "Bash", input: { command: "npm run build" } };
const other = (i) => ({ tool: "Read", input: { file_path: `/p/${i}.ts` } });

/** Fail `rounds` times; the session's cost grows by `roundUsd` per round. */
function loop(s, rounds, roundUsd, start = 1) {
  let event = null;
  for (let i = 0; i < rounds; i++) {
    recordAttempt(s, build, cfg, start + i * roundUsd);
    event = recordFailure(s, { ...build, error: "Error: Cannot find module 'x'" }, cfg) ?? event;
  }
  return event;
}

test("a loop that stays quiet after the hint is credited: rounds so far x measured cost per round", () => {
  const s = emptySession("a");
  assert.equal(loop(s, 3, 0.1).level, 1);
  assert.deepEqual(settleRescues(s), { usd: 0, loops: 0 }, "not yet: needs quiet calls");
  for (let i = 0; i < 7; i++) recordAttempt(s, other(i), cfg, 2);
  assert.equal(settleRescues(s).loops, 0);
  recordAttempt(s, other(9), cfg, 2);
  const r = settleRescues(s);
  assert.equal(r.loops, 1);
  close(r.usd, 0.3);
  assert.equal(s.pending.length, 0);
});

test("a recurring loop is not credited until it really stops; turn end needs 2 quiet calls", () => {
  const s = emptySession("b");
  loop(s, 3, 0.2);
  for (let i = 0; i < 5; i++) recordAttempt(s, other(i), cfg, 2);
  loop(s, 1, 0.2, 3); // came back
  recordAttempt(s, other(20), cfg, 3);
  assert.equal(settleRescues(s, true).loops, 0, "only 1 quiet call");
  recordAttempt(s, other(21), cfg, 3);
  const r = settleRescues(s, true);
  assert.equal(r.loops, 1);
  assert.ok(r.usd > 0);
});

test("a loop that ends with 'tell the user you are stuck' is never credited", () => {
  const s = emptySession("c");
  for (let i = 1; i <= 8; i++) {
    recordAttempt(s, { tool: "Edit", input: { file_path: "/p/a.ts", old_string: `${i}`, new_string: `${i + 1}` } }, cfg, i);
    recordAttempt(s, { tool: "Bash", input: { command: "npm test" } }, cfg, i + 0.5);
    recordFailure(s, { tool: "Bash", input: { command: "npm test" }, error: "AssertionError: expected 1 to equal 2" }, cfg);
  }
  for (let i = 0; i < 10; i++) recordAttempt(s, other(i), cfg, 20);
  assert.equal(settleRescues(s, true).loops, 0);
});

test("without cost stamps the round cost falls back to the session average per call", () => {
  const s = emptySession("d");
  recordAttempt(s, other(1), cfg, 4); // 1 call so far, $4 spent
  loop(s, 3, 0, 4); // stamps stay at $4: no measurable per-round delta
  for (let i = 0; i < 8; i++) recordAttempt(s, other(i + 2), cfg, 4);
  close(settleRescues(s).usd, 3 * (4 / 4)); // $4 over 4 calls when the hint was given
});

const writeDay = (date, patch) => {
  mkdirSync(join(home, "usage"), { recursive: true });
  writeFileSync(join(home, "usage", `${date}.json`), JSON.stringify({ ...emptyDay(date), ...patch }));
};

test("value of a 5-hour limit from window cost and used share; savings as share of it", () => {
  const now = new Date();
  writeDay(localDay(now), { costUsd: 6, byHour: { [String(now.getHours())]: 6 } });
  saveRateLimits({ five_hour: { used_percentage: 30, resets_at: Math.floor(now.getTime() / 1000) + 3600 } }, now.getTime());
  close(fiveHourLimitUsd(now.getTime()), 20);
  const sub = structuredClone(DEFAULT_CONFIG);
  sub.plan = "subscription";
  assert.equal(savingsLabel(sub, "de", 2, 20), "≈ 2,00 $ · ≈ 10 % eines 5-Stunden-Limits");
  const api = structuredClone(DEFAULT_CONFIG);
  api.plan = "api";
  assert.equal(savingsLabel(api, "en", 2, 20), "≈ $2.00");
  // Later, without fresh limit data, the cached value is used.
  close(fiveHourLimitUsd(now.getTime() + 2 * 3600 * 1000), 20);
});

test("report and one-line summary", () => {
  const date = "2026-03-10";
  writeDay(date, {
    costUsd: 12.5,
    byModel: { "claude-opus-5-5": 12 },
    guard: { denied: 2, asked: 1 },
    loops: { hints: 3, blocks: 1 },
    savings: { usd: 1.8, loopsRescued: 2 },
    handoffs: 1,
  });
  const api = structuredClone(DEFAULT_CONFIG);
  api.plan = "api";
  const report = buildReport(api, "en", date);
  assert.match(report, /Daily report/);
  assert.match(report, /Cost\s+≈ \$12\.50 · daily budget \$25\.00 \(50%\)/);
  assert.match(report, /Saved\s+≈ \$1\.80/);
  assert.match(report, /2 loop\(s\) rescued/);
  assert.match(report, /2 blocked, 1 held for approval/);
  assert.match(report, /Handoffs\s+1/);
  assert.match(report, /estimates at API list prices/);
  const line = shortSummary(api, "en", date);
  assert.match(line, /≈ \$12\.50 cost · ≈ \$1\.80 saved \(2 loops rescued\) · 3 actions intercepted/);
  assert.equal(shortSummary(api, "en", "2001-01-01"), null, "quiet day: nothing to say");
});

test("the daily summary shows once per day", () => {
  const now = new Date(2026, 2, 11, 9, 0);
  const api = structuredClone(DEFAULT_CONFIG);
  api.plan = "api";
  assert.match(dailySummaryOnce(api, "en", now), /SteinWall yesterday/);
  assert.equal(dailySummaryOnce(api, "en", now), null);
});
