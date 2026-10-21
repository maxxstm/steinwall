import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STEINWALL_HOME = mkdtempSync(join(tmpdir(), "sw-loops-"));
const { recordOutcome, blockedRepeat, errorFingerprint, failureText } = await import("../dist/core/loops.js");
const { emptySession } = await import("../dist/core/session.js");
const { DEFAULT_CONFIG } = await import("../dist/core/config.js");
const { saveRateLimits, nearLimit, writeAutoSection, readHandoff, handoffPath } = await import("../dist/core/handoff.js");

const cfg = structuredClone(DEFAULT_CONFIG);
const bash = (command) => ({ tool: "Bash", input: { command } });
const fail = (call, error = "Error: Cannot find module 'x'") => ({ ...call, error });
const ok = (call) => ({ ...call, error: null });
const edit = { tool: "Edit", input: { file_path: "/p/a.ts", old_string: "a", new_string: "b" } };

test("blind retry: hint at 3, block at 5, unblocked once a file changes", () => {
  const s = emptySession("s");
  const run = () => recordOutcome(s, fail(bash("npm run build")), cfg);
  assert.equal(run(), null);
  assert.equal(run(), null);
  assert.deepEqual([run().kind, run.length], ["blind-retry", 0]);
  assert.equal(run(), null);
  const e = run();
  assert.equal(e.kind, "blind-retry");
  assert.equal(e.level, 2);
  assert.ok(blockedRepeat(s, "Bash", { command: "npm  run build" }), "whitespace-insensitive");
  assert.equal(blockedRepeat(s, "Bash", { command: "npm test" }), null);
  recordOutcome(s, ok(edit), cfg);
  assert.equal(blockedRepeat(s, "Bash", { command: "npm run build" }), null);
});

test("a success of the same call resets the blind count", () => {
  const s = emptySession("s");
  recordOutcome(s, fail(bash("make")), cfg);
  recordOutcome(s, fail(bash("make")), cfg);
  recordOutcome(s, ok(bash("make")), cfg);
  assert.equal(recordOutcome(s, fail(bash("make")), cfg), null);
  assert.equal(recordOutcome(s, fail(bash("make")), cfg), null);
});

test("same error across edited attempts: hint, strategy change, tell the user", () => {
  const s = emptySession("s");
  const levels = [];
  for (let i = 1; i <= 8; i++) {
    recordOutcome(s, ok({ tool: "Edit", input: { file_path: "/p/a.ts", old_string: `v${i}`, new_string: `v${i + 1}` } }), cfg);
    const e = recordOutcome(s, fail(bash("npm test"), `FAIL src/a.test.ts\n  AssertionError: expected ${i} to equal 42 at /p/a.test.ts:${10 + i}`), cfg);
    levels.push(e ? `${e.kind}:${e.level}` : null);
  }
  assert.deepEqual(levels, [null, null, "same-error:1", null, "same-error:2", null, null, "same-error:3"]);
  assert.equal(blockedRepeat(s, "Bash", { command: "npm test" }), null, "edits in between: never blocked");
});

test("repeating a successful call without changes gets one hint", () => {
  const s = emptySession("s");
  const read = { tool: "Read", input: { file_path: "/p/a.ts" } };
  const events = Array.from({ length: 8 }, () => recordOutcome(s, ok(read), cfg)).filter(Boolean);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, "repeat");
});

test("SteinWall's own blocks are not counted; loop rescue can be turned off", () => {
  const s = emptySession("s");
  for (let i = 0; i < 6; i++) recordOutcome(s, fail(bash("x"), "SteinWall blocked this action"), cfg);
  assert.equal(s.calls.length, 0);
  const off = structuredClone(DEFAULT_CONFIG);
  off.loop.enabled = false;
  for (let i = 0; i < 6; i++) assert.equal(recordOutcome(s, fail(bash("y")), off), null);
});

test("error fingerprints ignore numbers, paths and ids", () => {
  assert.equal(
    errorFingerprint("Error: Cannot find module '/home/a/x.js'\n    at line 12 (pid 4411)"),
    errorFingerprint("Error: Cannot find module 'C:\\b\\y.js'\n    at line 97 (pid 18)"),
  );
  assert.notEqual(errorFingerprint("TypeError: x is undefined"), errorFingerprint("SyntaxError: unexpected token"));
});

test("failure detection in tool responses", () => {
  assert.equal(failureText({ stdout: "ok", stderr: "" }), null);
  assert.equal(failureText("File written"), null);
  assert.match(failureText({ is_error: true, content: "boom" }), /boom/);
  assert.match(failureText({ exitCode: 2, stderr: "bad" }), /bad/);
  assert.match(failureText("Error: exit code 1"), /exit code/);
  assert.equal(failureText({ exitCode: 0 }), null);
});

test("rate limits: threshold, staleness, epoch conversion", () => {
  const now = Date.now();
  saveRateLimits({ five_hour: { used_percentage: 87, resets_at: Math.floor(now / 1000) + 3600 }, seven_day: { used_percentage: 40 } }, now);
  const near = nearLimit(cfg, now);
  assert.equal(near.window, "five_hour");
  assert.ok(near.resetsAt.startsWith("20"));
  assert.equal(nearLimit(cfg, now + 31 * 60 * 1000), null, "stale data is ignored");
  saveRateLimits({ five_hour: { used_percentage: 50 } }, now);
  assert.equal(nearLimit(cfg, now), null);
  saveRateLimits({ seven_day: { used_percentage: 95 } }, now);
  assert.equal(nearLimit(cfg, now).window, "seven_day");
});

test("handoff file: template, gitignore, auto section refresh keeps the agent's text", () => {
  const cwd = mkdtempSync(join(tmpdir(), "sw-proj-"));
  const s = { ...emptySession("abc"), lastPrompt: "Build the login page", files: [join(cwd, "src", "login.ts")] };
  const path = writeAutoSection(cwd, s, "limit warning");
  assert.equal(path, handoffPath(cwd));
  assert.equal(readFileSync(join(cwd, ".steinwall", ".gitignore"), "utf8"), "*\n");
  let text = readFileSync(path, "utf8");
  assert.match(text, /^<!-- steinwall:handoff status=open/);
  assert.match(text, /Last user request: Build the login page/);
  assert.match(text, /src[\\/]login\.ts/);

  writeFileSync(path, text.replace("## Next step\n", "## Next step\nWire the submit button.\n"));
  s.lastPrompt = "Also add a logout";
  writeAutoSection(cwd, s, "usage limit reached");
  text = readFileSync(path, "utf8");
  assert.match(text, /Wire the submit button/);
  assert.match(text, /Also add a logout/);
  assert.equal(text.match(/steinwall:auto:start/g).length, 1);
  assert.equal(readHandoff(cwd).status, "open");

  writeFileSync(path, text.replace("status=open", "status=done"));
  assert.equal(readHandoff(cwd).status, "done");
  writeAutoSection(cwd, s, "limit warning");
  assert.equal(readHandoff(cwd).status, "open");
  assert.doesNotMatch(readFileSync(path, "utf8"), /Wire the submit button/, "a finished handoff is replaced");
  assert.ok(existsSync(path));
});

test("optimistic recording: a failure reported after other calls started flips the right record", async () => {
  const { recordAttempt, recordFailure } = await import("../dist/core/loops.js");
  const s = emptySession("p");
  for (let i = 0; i < 3; i++) {
    recordAttempt(s, bash("npm test"), cfg);
    recordAttempt(s, { tool: "Read", input: { file_path: `/p/${i}.ts` } }, cfg); // runs in parallel
    const e = recordFailure(s, { ...bash("npm test"), error: "Error: 1 test failed" }, cfg);
    if (i < 2) assert.equal(e, null);
    else assert.equal(e.kind, "blind-retry");
  }
  assert.equal(s.calls.filter((c) => !c.ok).length, 3);
  assert.equal(s.calls.filter((c) => c.ok).length, 3, "the parallel reads stay successes");
});
