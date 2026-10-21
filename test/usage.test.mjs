import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "sg-usage-"));
process.env.STEINWALL_HOME = home;
const { costUsd, priceFor } = await import("../dist/core/pricing.js");
const { ingestSession, loadDay, monthCost } = await import("../dist/core/usage.js");
const { evaluateBudget } = await import("../dist/core/budget.js");
const { DEFAULT_CONFIG } = await import("../dist/core/config.js");
const { localDay } = await import("../dist/core/fsutil.js");

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const u = (o) => ({ input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, ...o });

test("pricing: list prices, cache multipliers, prefixes, fast mode", () => {
  close(costUsd("claude-opus-5-5", u({ input: 1e6, output: 1e6 })), 24);
  close(costUsd("claude-sonnet-5-5", u({ cacheWrite5m: 1e6, cacheWrite1h: 1e6, cacheRead: 1e6 })), 2.5 + 4 + 0.2);
  close(costUsd("claude-haiku-4-5-20251001", u({ input: 1e6 })), 1);
  close(costUsd("us.anthropic.claude-sonnet-4-5-20250929-v1:0", u({ output: 1e6 })), 15);
  close(costUsd("claude-opus-5-5", u({ output: 1e6 }), { fast: true }), 40);
  assert.equal(priceFor("claude-opus-4-1-20250805").key, "claude-opus-4-1");
  assert.equal(priceFor("claude-opus-4-20250514").key, "claude-opus-4");
  assert.equal(priceFor("claude-sonnet-5-5[1m]").key, "claude-sonnet-5-5");
  assert.equal(priceFor("gpt-9").known, false);
  // Haiku 5.5 long-context tier above 100K prompt tokens
  close(costUsd("claude-haiku-5-5", u({ input: 200_000 })), 0.1);
});

const line = (o) =>
  JSON.stringify({
    type: "assistant",
    timestamp: o.ts ?? new Date().toISOString(),
    requestId: o.req ?? "req_1",
    message: { id: o.id, model: o.model ?? "claude-opus-5-5", usage: o.usage },
  }) + "\n";

test("ingestion: dedupes repeated message lines, counts streaming deltas, waits for full lines", () => {
  const dir = join(home, "projects", "p1");
  mkdirSync(dir, { recursive: true });
  const transcript = join(dir, "s1.jsonl");
  const usage = { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "hi" } }) + "\n");
  appendFileSync(transcript, line({ id: "m1", usage }) + line({ id: "m1", usage }));
  const first = ingestSession(transcript, "s1").addedUsd;
  close(first, (1000 * 4 + 100 * 20) / 1e6);

  // Same message again with more output tokens: only the delta counts.
  appendFileSync(transcript, line({ id: "m1", usage: { ...usage, output_tokens: 300 } }));
  close(ingestSession(transcript, "s1").addedUsd, (200 * 20) / 1e6);

  // A partial line is left for the next call.
  const full = line({ id: "m2", usage });
  appendFileSync(transcript, full.slice(0, 40));
  close(ingestSession(transcript, "s1").addedUsd, 0);
  appendFileSync(transcript, full.slice(40));
  close(ingestSession(transcript, "s1").addedUsd, first);

  // Nothing new -> nothing added.
  close(ingestSession(transcript, "s1").addedUsd, 0);

  const day = loadDay(localDay());
  close(day.costUsd, first * 2 + (200 * 20) / 1e6);
  assert.equal(day.tokens.output, 400);
  close(day.sessions.s1, day.costUsd);
});

test("ingestion: subagent transcripts, cache split, day attribution, unknown models", () => {
  const dir = join(home, "projects", "p2");
  const transcript = join(dir, "s2.jsonl");
  mkdirSync(join(dir, "s2", "subagents"), { recursive: true });
  writeFileSync(
    transcript,
    line({
      id: "a",
      ts: "2026-01-15T12:00:00Z",
      model: "claude-sonnet-5-5",
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_5m_input_tokens: 1e6, ephemeral_1h_input_tokens: 1e6 } },
    }),
  );
  writeFileSync(join(dir, "s2", "subagents", "agent-1.jsonl"), line({ id: "b", model: "claude-new-9", usage: { input_tokens: 1e6, output_tokens: 0 } }));
  ingestSession(transcript, "s2").addedUsd;
  const jan = loadDay(localDay(new Date("2026-01-15T12:00:00Z")));
  close(jan.costUsd, 2.5 + 4);
  const today = loadDay(localDay());
  assert.ok(today.unknownModels.includes("claude-new-9"));
  close(monthCost(jan.date.slice(0, 7)), jan.costUsd);
});

test("budget: warn, exceeded, subscription not enforced unless opted in, override", () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  cfg.plan = "api";
  cfg.budget.dailyUsd = 10;
  cfg.budget.monthlyUsd = 100;
  const day = (costUsd, flags = {}) => ({ ...loadDay("2000-01-01"), costUsd, flags });

  assert.equal(evaluateBudget(cfg, day(5), 5).worst, null);
  assert.equal(evaluateBudget(cfg, day(8.5), 9).worst.state, "warn");
  const ex = evaluateBudget(cfg, day(10.2), 50);
  assert.equal(ex.worst.state, "exceeded");
  assert.equal(ex.worst.kind, "daily");
  assert.equal(ex.enforced, true);
  assert.equal(evaluateBudget(cfg, day(2), 120).worst.kind, "monthly");
  assert.equal(evaluateBudget(cfg, day(12, { override: true }), 12).enforced, false);

  cfg.plan = "subscription";
  assert.equal(evaluateBudget(cfg, day(12), 12).enforced, false);
  cfg.budget.enforceOnSubscription = true;
  assert.equal(evaluateBudget(cfg, day(12), 12).enforced, true);
  cfg.budget.dailyUsd = null;
  assert.equal(evaluateBudget(cfg, day(12), 12).daily, null);
});

test("plan auto-detection", () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  assert.equal(evaluateBudget(cfg, loadDay("2000-01-01"), 0, { ANTHROPIC_API_KEY: "x" }).plan, "api");
  assert.equal(evaluateBudget(cfg, loadDay("2000-01-01"), 0, {}).plan, "subscription");
});
