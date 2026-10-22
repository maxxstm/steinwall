// SteinWall Briefing for Codex: reading rollout logs, counterfactual savings, and the briefing text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STEINWALL_HOME = mkdtempSync(join(tmpdir(), "sw-lite-"));
const { commandsOf, failed, readRollout, buildBriefing, collect, main } = await import("../dist/lite/codex-lite.js");
const { localDay } = await import("../dist/core/fsutil.js");

const DAY = localDay();
const ts = (h, m = 0) => new Date(`${DAY}T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`).toISOString();
let total = 0;
const tokens = (h, input = 10_000, output = 1_000) => {
  total += input + output;
  return { timestamp: ts(h), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: output } }, rate_limits: { primary: { used_percent: 42, window_minutes: 300, resets_at: 1_900_000_000 }, secondary: { used_percent: 18, window_minutes: 10080 } } } };
};
const exec = (id, cmd) => ({ timestamp: ts(10), type: "response_item", payload: { type: "custom_tool_call", call_id: id, name: "exec", input: `const r = await tools.exec_command({cmd:${JSON.stringify(cmd)}, workdir:"."});` } });
const out = (id, code) => ({ timestamp: ts(10), type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: [{ type: "input_text", text: `Script completed\nOutput:\n{"exit_code":${code},"output":"..."}` }] } });

function rollout() {
  total = 0;
  const lines = [{ timestamp: ts(9), type: "turn_context", payload: { model: "gpt-6.1-sol" } }];
  for (let i = 0; i < 4; i++) lines.push(tokens(10), exec(`c${i}`, "npm test"), out(`c${i}`, 1));
  lines.push(tokens(11), exec("p", "git push --force origin main"), out("p", 0));
  lines.push(tokens(11), tokens(11)); // the second is a repeat with the same total, not a new request
  lines[lines.length - 1] = { ...lines[lines.length - 2] };
  return lines.map((l) => JSON.stringify(l)).join("\n");
}

test("commands are read from Codex app exec cells and shell calls", () => {
  assert.deepEqual(commandsOf({ type: "custom_tool_call", input: 'await tools.exec_command({cmd:"git status"}); await tools.exec_command({cmd:\'rm -rf dist\'})' }), ["git status", "rm -rf dist"]);
  assert.deepEqual(commandsOf({ type: "function_call", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "ls -la"] }) }), ["ls -la"]);
  assert.deepEqual(commandsOf({ type: "local_shell_call", action: { command: ["git", "push", "--force"] } }), ["git push --force"]);
  assert.deepEqual(commandsOf({ type: "function_call", name: "wait", arguments: "{}" }), []);
  assert.equal(failed([{ text: '{"exit_code":2}' }]), true);
  assert.equal(failed([{ text: '{"exit_code":0}' }]), false);
  assert.equal(failed("Process exited with code 1"), true);
});

test("a rollout yields cost, limits, a stuck loop with its extra rounds, and risky commands", () => {
  const days = new Map();
  const limits = { at: 0, value: {} };
  readRollout(rollout(), "s1", days, limits);
  const d = days.get(DAY);
  assert.equal(d.requests, 6, "repeated token events are not counted twice");
  assert.ok(d.costUsd > 0);
  assert.deepEqual(Object.keys(d.byModel), ["gpt-6.1-sol"]);
  assert.equal(limits.value.fiveHour.usedPercent, 42);
  assert.equal(limits.value.weekly.usedPercent, 18);
  assert.equal(d.loops.length, 1);
  assert.equal(d.loops[0].failures, 4);
  assert.ok(Math.abs(d.loops[0].wastedUsd - 2 * (d.costUsd / d.requests)) < 1e-9, "rounds after the 3rd failure hint: 4 - 2 = 2 rounds");
  assert.deepEqual(d.risky.map((r) => r.rule), ["force-push"]);
});

test("the briefing shows what the hook edition would have saved, then neutral notes on what is not included", () => {
  const days = new Map();
  const limits = { at: 0, value: {} };
  readRollout(rollout(), "s1", days, limits);
  const en = buildBriefing("en", DAY, days, limits.value);
  assert.match(en, /Daily briefing .* \(Codex\)/);
  assert.match(en, /Limits\s+5-hour 42%.* · weekly 18%/);
  assert.match(en, /1 stuck loop\(s\) \(same command failed 3\+ times\): ≈ \$\d+\.\d\d could have been saved/);
  assert.match(en, /4x {2}npm test/);
  assert.match(en, /force push.*git push --force origin main/i);
  assert.match(en, /→ Not included here: stepping in automatically .*codex plugin marketplace add maxxstm\/steinwall/);
  assert.match(en, /→ Also not included: cheaper subagents in Claude Code.*\(SteinWall Pro\)\. Overview: https:\/\/steinwall\.dev/);
  // OpenAI's directory rules: no prices, trials, offers or upgrade pitches.
  assert.doesNotMatch(en, /free|trial|\$\d+\/month|buy|upgrade|discount/i);
  const de = buildBriefing("de", DAY, days, limits.value);
  assert.match(de, /Tagesbriefing/);
  assert.match(de, /wären gespart worden/);
  const quiet = buildBriefing("en", DAY, new Map(), {});
  assert.match(quiet, /Nothing: no stuck loops, no risky commands\./);
  assert.match(quiet, /\(SteinWall Pro\)/);
});

test("collect reads rollouts from CODEX_HOME/sessions/YYYY/MM/DD and the CLI prints the briefing", () => {
  const home = mkdtempSync(join(tmpdir(), "sw-codex-"));
  const dir = join(home, "sessions", ...DAY.split("-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rollout-2026-test.jsonl"), rollout());
  process.env.CODEX_HOME = home;
  const { days } = collect([DAY]);
  assert.equal(days.get(DAY).loops.length, 1);
  assert.match(main(["briefing", "--lang", "en"]), /could have been saved/);
  assert.match(main(["scan", "--lang", "en"]), /Missing path/);
  assert.match(main(["nope", "--lang", "en"]), /Usage:/);
  delete process.env.CODEX_HOME;
});
