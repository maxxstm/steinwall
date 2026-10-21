// End-to-end loop rescue and limit handoff through the real hook and status line binaries.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const home = mkdtempSync(join(tmpdir(), "sw-rescue-"));
const env = { ...process.env, STEINWALL_HOME: join(home, "sw"), CLAUDE_CONFIG_DIR: join(home, "claude"), LOCALAPPDATA: join(home, "lad"), CLAUDE_CODE_EXECPATH: "", LANG: "en_US.UTF-8", NO_COLOR: "1", ANTHROPIC_API_KEY: "" };
const project = join(home, "project");
mkdirSync(project);
const transcript = join(home, "t", "s.jsonl");
mkdirSync(dirname(transcript), { recursive: true });
writeFileSync(transcript, "");

const run = (script, input) => {
  const r = spawnSync(process.execPath, [join(root, "dist", "bin", script)], { input: JSON.stringify(input), env, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};
const hook = (input) => {
  const out = run("hook.js", { session_id: "s1", transcript_path: transcript, cwd: project, ...input });
  return out ? JSON.parse(out) : null;
};
const failBuild = () => hook({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "npm run build" }, error: "Exit code 1\nError: Cannot find module 'left-pad'" });
const preBuild = () => hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm run build" } });

test("loop rescue: hint after 3 blind failures, block after 5, unblock after an edit", () => {
  assert.equal(failBuild(), null);
  assert.equal(failBuild(), null);
  const hint = failBuild();
  assert.equal(hint.hookSpecificOutput.hookEventName, "PostToolUseFailure");
  assert.match(hint.hookSpecificOutput.additionalContext, /failed 3× in a row/);
  failBuild();
  assert.match(failBuild().hookSpecificOutput.additionalContext, /blocked until a file changes/);

  const blocked = preBuild();
  assert.equal(blocked.hookSpecificOutput.permissionDecision, "deny");
  assert.match(blocked.hookSpecificOutput.permissionDecisionReason, /failed 5× unchanged/);

  // A file edit (recorded when it starts) lifts the block.
  assert.equal(hook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: join(project, "package.json"), old_string: "a", new_string: "b" } }), null);
  assert.equal(preBuild(), null);
});

test("limit handoff: nudge once per window, Stop keeps the agent going once, next session resumes", () => {
  run("statusline.js", { session_id: "s1", rate_limits: { five_hour: { used_percentage: 91, resets_at: Math.floor(Date.now() / 1000) + 1800 } } });

  const first = hook({ hook_event_name: "UserPromptSubmit", prompt: "Implement the export button" });
  assert.match(first.hookSpecificOutput.additionalContext, /91% of your 5-hour limit used/);
  const path = join(project, ".steinwall", "handoff.md");
  assert.ok(existsSync(path));
  assert.match(readFileSync(path, "utf8"), /Implement the export button/);
  assert.match(readFileSync(path, "utf8"), /package\.json/);
  assert.equal(hook({ hook_event_name: "UserPromptSubmit", prompt: "go on" }), null, "only once per window");

  // The agent did not touch the file: Stop asks once to write it, then lets go.
  utimesSync(path, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const stop = hook({ hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(stop.decision, "block");
  assert.match(stop.reason, /handoff/);
  assert.equal(hook({ hook_event_name: "Stop", stop_hook_active: true }), null);
  assert.equal(hook({ hook_event_name: "Stop", stop_hook_active: false }), null);

  const resume = hook({ session_id: "s2", hook_event_name: "SessionStart", source: "startup" });
  assert.match(resume.hookSpecificOutput.additionalContext, /open handoff/);
  writeFileSync(path, readFileSync(path, "utf8").replace("status=open", "status=done"));
  const done = hook({ session_id: "s3", hook_event_name: "SessionStart", source: "startup" });
  assert.doesNotMatch(done?.hookSpecificOutput?.additionalContext ?? "", /open handoff/, "a finished handoff is not offered again");
});

test("limit hit without limit data: SteinWall saves the handoff itself", () => {
  const other = join(home, "other");
  mkdirSync(other);
  const t2 = join(home, "t", "s9.jsonl");
  writeFileSync(
    t2,
    JSON.stringify({ type: "assistant", isApiErrorMessage: true, timestamp: new Date().toISOString(), message: { content: [{ type: "text", text: "Claude usage limit reached. Your limit will reset at 5pm." }] } }) + "\n",
  );
  const out = run("hook.js", { session_id: "s9", transcript_path: t2, cwd: other, hook_event_name: "Stop" });
  assert.match(JSON.parse(out).systemMessage, /Usage limit reached/);
  assert.ok(existsSync(join(other, ".steinwall", "handoff.md")));
});

test("status shows loop counters", () => {
  const r = spawnSync(process.execPath, [join(root, "dist", "cli.js"), "status"], { env, encoding: "utf8" });
  assert.match(r.stdout, /Loop rescue today: 1 hints, 1 strategy changes/);
});

test("savings: a rescued loop is priced from transcript costs and appears in the report", () => {
  const sid = "loop-cost";
  const t3 = join(home, "t", `${sid}.jsonl`);
  writeFileSync(t3, "");
  const spend = (id) =>
    writeFileSync(t3, JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { id, model: "claude-opus-5-5", usage: { input_tokens: 0, output_tokens: 5000 } } }) + "\n", { flag: "a" });
  const h = (input) => {
    const out = run("hook.js", { session_id: sid, transcript_path: t3, cwd: project, ...input });
    return out ? JSON.parse(out) : null;
  };
  // Each round: the model spends $0.10 (5000 output tokens at $20/M), then the call fails.
  for (let i = 0; i < 3; i++) {
    spend(`m${i}`);
    h({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "make" } });
    h({ hook_event_name: "PostToolUseFailure", tool_name: "Bash", tool_input: { command: "make" }, error: "make: *** No rule to make target" });
  }
  // The agent changes course; the turn ends calmly.
  h({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "Makefile" } });
  h({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "README.md" } });
  h({ hook_event_name: "Stop", stop_hook_active: false });

  const report = spawnSync(process.execPath, [join(root, "dist", "cli.js"), "report"], { env, encoding: "utf8" }).stdout;
  assert.match(report, /Saved\s+≈ \$0\.30/); // 3 rounds x $0.10
  // The first test's loop (no transcript costs there, so $0) also stayed quiet after its block: 2 rescued.
  assert.match(report, /2 loop\(s\) rescued/);
});
