// Pro features: project rules, routing savings, context advisor, Codex output trimming, cost coach,
// telemetry consent and sending, dashboard, savings card, upgrade line.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "sw-pro-"));
process.env.STEINWALL_HOME = join(home, "sw");
process.env.CLAUDE_CONFIG_DIR = join(home, "claude");
process.env.CODEX_HOME = join(home, "codex");
process.env.LOCALAPPDATA = join(home, "lad");
delete process.env.CLAUDE_CODE_EXECPATH;

const { checkCustomRules, globToRegex } = await import("../dist/core/rules.js");
const pro = await import("../dist/core/pro.js");
const { DEFAULT_CONFIG } = await import("../dist/core/config.js");
const { runBackground, telemetryQuestionOnce } = await import("../dist/adapters/claude-code/background.js");
const { renderDashboard, collectDays } = await import("../dist/core/dashboard.js");
const { cardHeadline, renderCardSvg } = await import("../dist/core/card.js");
const { upgradeLine } = await import("../dist/core/report.js");
const { emptyDay } = await import("../dist/core/usage.js");
const { localDay } = await import("../dist/core/fsutil.js");

const project = join(home, "project");
mkdirSync(join(project, ".steinwall"), { recursive: true });
writeFileSync(
  join(project, ".steinwall", "rules.json"),
  JSON.stringify({ deny: ["terraform apply"], ask: ["^npm publish"], allow: ["^rm -rf \\./tmp-"], protect: ["infra/prod/**", "*.sqlite"], message: "Prod goes through the pipeline." }),
);

test("project rules: deny, ask, allow and protected paths", () => {
  const bash = (command) => checkCustomRules("Bash", { command }, project);
  assert.equal(bash("cd infra && terraform apply -auto-approve").decision, "deny");
  assert.match(bash("terraform apply").reason, /pipeline/);
  assert.equal(bash("npm publish --access public").decision, "ask");
  assert.equal(bash("rm -rf ./tmp-build"), "allow");
  assert.equal(bash("rm infra/prod/main.tf").decision, "deny");
  assert.equal(bash("ls infra/prod"), null, "reading is fine");
  assert.equal(checkCustomRules("Write", { file_path: join(project, "infra", "prod", "x.tf"), content: "" }, project).decision, "deny");
  assert.equal(checkCustomRules("Edit", { file_path: join(project, "data", "app.sqlite") }, project).decision, "deny");
  assert.equal(checkCustomRules("apply_patch", { command: "*** Begin Patch\n*** Update File: infra/prod/vars.tf\n+x\n*** End Patch" }, project).decision, "deny");
  assert.equal(checkCustomRules("Write", { file_path: join(project, "src", "a.ts") }, project), null);
  assert.equal(checkCustomRules("Bash", { command: "terraform apply" }, join(home, "elsewhere")), null, "rules only apply inside the project");
  assert.ok(globToRegex("infra/prod/**").test("infra/prod/a/b.tf"));
});

test("routing: the scout's tokens priced at the main model vs its own model", () => {
  const line = (model, id, u) => JSON.stringify({ type: "assistant", message: { id, model, usage: u } });
  const text = [line("claude-haiku-5-5", "a", { input_tokens: 20_000, output_tokens: 2000 }), line("claude-haiku-5-5", "a", { input_tokens: 20_000, output_tokens: 2000 }), "[steinwall-scout]"].join("\n");
  const r = pro.routingSavings(text, "claude-opus-5-5");
  // Opus 5.5: 20K*$4 + 2K*$20 = $0.12; Haiku 5.5: 20K*$0.10 + 2K*$0.50 = $0.003
  assert.ok(Math.abs(r.onMain - 0.12) < 1e-9);
  assert.ok(Math.abs(r.actual - 0.003) < 1e-9);
  assert.ok(Math.abs(r.saved - 0.117) < 1e-9);
  assert.ok(pro.isScout("steinwall:scout", ""));
  assert.ok(pro.isScout(undefined, "... [steinwall-scout]"));
  assert.ok(!pro.isScout("Explore", "nothing"), "Claude's own subagents are not credited to SteinWall");
});

test("context advisor: levels and message", () => {
  assert.equal(pro.contextLevel(100_000, 150_000), 0);
  assert.equal(pro.contextLevel(150_000, 150_000), 1);
  assert.equal(pro.contextLevel(260_000, 150_000), 3);
  assert.match(pro.contextAdvice("en", "claude-opus-5-5", 200_000, "claude", "Fix the login"), /≈ 200K tokens.*\$0\.04 \(cached\) to \$0\.80.*\/compact focus: Fix the login/);
});

test("Codex output trimming keeps head and tail and prices the removed part", () => {
  const big = "A".repeat(50_000) + "MIDDLE" + "Z".repeat(50_000);
  const t = pro.trimOutput(big, 30_000, "en");
  assert.ok(t.text.startsWith("A".repeat(100)) && t.text.endsWith("Z".repeat(100)));
  assert.ok(!t.text.includes("MIDDLE"));
  assert.match(t.text, /characters in the middle trimmed/);
  assert.equal(pro.trimOutput("short", 30_000, "en"), null);
  assert.ok(Math.abs(pro.trimSavings(4_000_000, "gpt-6.1-sol") - 2) < 1e-9, "1M tokens at $2/M");
});

test("cost coach estimates and gives tips", () => {
  const msg = pro.costCoach("en", "claude-opus-5-5", 100_000, "Please read the whole codebase and " + "x".repeat(7000));
  assert.match(msg, /Cost coach: this request ≈ \$0\.0\d/);
  assert.match(msg, /Long text/);
  assert.match(msg, /Read everything/);
});

test("telemetry: question once, nothing sent without consent, one number per finished day with consent", async () => {
  const cfg = structuredClone(DEFAULT_CONFIG);
  assert.match(telemetryQuestionOnce(cfg, "en"), /random install id/);
  assert.equal(telemetryQuestionOnce(cfg, "en"), null, "asked once");

  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response("{}", { status: 200 });
  };
  cfg.license.apiUrl = "https://api.example/functions/v1";
  assert.deepEqual((await runBackground(cfg, fake)).sentDays, [], "off by default: nothing sent");
  assert.equal(calls.length, 0);

  cfg.telemetry.enabled = true;
  const now = new Date();
  const yesterday = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  mkdirSync(join(home, "sw", "usage"), { recursive: true });
  writeFileSync(join(home, "sw", "usage", `${yesterday}.json`), JSON.stringify({ ...emptyDay(yesterday), savings: { usd: 3.456, loopsRescued: 1 } }));
  const r = await runBackground(cfg, fake, now);
  assert.equal(r.sentDays.length, 7);
  const sent = calls.find((c) => c.body.day === yesterday).body;
  assert.deepEqual(Object.keys(sent).sort(), ["day", "installId", "savedUsd"], "nothing but these three fields");
  assert.equal(sent.savedUsd, 3.46);
  assert.match(sent.installId, /^[0-9a-f-]{36}$/);
  assert.ok(calls.every((c) => c.url.endsWith("/telemetry")));
  assert.equal(calls.some((c) => c.body.day === localDay(now)), false, "today is never sent");
  calls.length = 0;
  assert.deepEqual((await runBackground(cfg, fake, now)).sentDays, [], "each day only once");
});

test("dashboard and card render from local data; card falls back to protection when savings are small", () => {
  const today = localDay();
  writeFileSync(join(home, "sw", "usage", `${today}.json`), JSON.stringify({ ...emptyDay(today), costUsd: 12, byModel: { "claude-opus-5-5": 12 }, guard: { denied: 2, asked: 1 }, savings: { usd: 4.2, loopsRescued: 2, bySource: { loops: 1.2, routing: 3 } } }));
  const html = renderDashboard("en", collectDays(7));
  assert.match(html, /Model routing<\/td><td>≈ \$3\.00/);
  assert.match(html, /claude-opus-5-5/);
  assert.doesNotMatch(html, /<script src=|https?:\/\//, "self-contained, no network");
  assert.equal(cardHeadline("de", { savedUsd: 47.2, intercepted: 3, loops: 2, days: 7 }), "SteinWall hat mir diese Woche ≈ 47,20 $ gespart");
  assert.equal(cardHeadline("en", { savedUsd: 0.2, intercepted: 3, loops: 0, days: 7 }), "SteinWall stopped 3 risky actions this week");
  assert.match(renderCardSvg("en", { savedUsd: 10, intercepted: 1, loops: 1, days: 7 }), /Spend less\. Break nothing\./);
});

test("upgrade line: measured trial savings only, never for Pro license holders", () => {
  const today = localDay();
  assert.match(upgradeLine("en", today, { pro: true, reason: "trial", trialDaysLeft: 2 }), /Pro trial \(2 day\(s\) left\): Pro has saved an extra ≈ \$3\.00/);
  assert.match(upgradeLine("de", today, { pro: false, reason: "none", trialDaysLeft: 0 }), /In deiner Testphase hat Pro ≈ 3,00 \$ zusätzlich gespart/);
  assert.equal(upgradeLine("en", today, { pro: true, reason: "license", trialDaysLeft: 0 }), null);
});

// --- through the real hook ---------------------------------------------------------------------------

const env = { ...process.env, LANG: "en_US.UTF-8", NO_COLOR: "1", ANTHROPIC_API_KEY: "", PLUGIN_ROOT: root };
const run = (bin, input) => {
  const r = spawnSync(process.execPath, [join(root, "dist", "bin", bin)], { input: JSON.stringify(input), env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
};

test("hook (trial = Pro): project rule denies, scout savings credited at SubagentStop", () => {
  const deny = run("hook.js", { hook_event_name: "PreToolUse", session_id: "p1", cwd: project, permission_mode: "default", tool_name: "Bash", tool_input: { command: "terraform apply" } });
  assert.match(deny.hookSpecificOutput.permissionDecisionReason, /project rule.*pipeline/);

  // Main conversation on Opus, then a scout run on Haiku.
  const t = join(home, "main.jsonl");
  writeFileSync(t, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { id: "m", model: "claude-opus-5-5", usage: { input_tokens: 1000, output_tokens: 10 } } }) + "\n");
  run("hook.js", { hook_event_name: "PreToolUse", session_id: "p2", transcript_path: t, cwd: project, tool_name: "Read", tool_input: { file_path: "a.ts" } });
  const scout = join(home, "scout.jsonl");
  writeFileSync(scout, JSON.stringify({ type: "assistant", message: { id: "s", model: "claude-haiku-5-5", usage: { input_tokens: 20_000, output_tokens: 2000 } } }) + "\n");
  run("hook.js", { hook_event_name: "SubagentStop", session_id: "p2", transcript_path: t, cwd: project, agent_type: "steinwall:scout", agent_transcript_path: scout });
  run("hook.js", { hook_event_name: "SubagentStop", session_id: "p2", transcript_path: t, cwd: project, agent_type: "steinwall:scout", agent_transcript_path: scout });
  const day = JSON.parse(readFileSync(join(home, "sw", "usage", `${localDay()}.json`), "utf8"));
  assert.ok(Math.abs(day.savings.bySource.routing - 3 - 0.117) < 1e-9, "credited once (on top of the earlier fixture's $3)");
});

test("hook (Codex, Pro): huge outputs are trimmed via PostToolUse block reason", () => {
  const out = run("codex-hook.js", { hook_event_name: "PostToolUse", session_id: "c9", cwd: project, model: "gpt-6.1-sol", tool_name: "Bash", tool_input: { command: "cat big.log" }, tool_response: "Exit code: 0\nOutput:\n" + "x".repeat(80_000) });
  assert.equal(out.decision, "block");
  assert.ok(out.reason.length < 32_000);
  assert.match(out.reason, /trimmed to save context/);
});

test("CLI: card and dashboard write files without opening them", () => {
  const r1 = spawnSync(process.execPath, [join(root, "dist", "cli.js"), "card", "--no-open"], { env, encoding: "utf8" });
  assert.ok(existsSync(r1.stdout.trim()));
  const r2 = spawnSync(process.execPath, [join(root, "dist", "cli.js"), "dashboard", "--no-open"], { env, encoding: "utf8" });
  assert.ok(existsSync(r2.stdout.trim()), "trial counts as Pro");
});
