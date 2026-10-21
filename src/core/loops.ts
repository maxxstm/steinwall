/**
 * Loop rescue. Goal: the task gets done, not aborted. Two patterns are tracked per session:
 *
 *  - blind retry:  the identical call fails again without any file having changed in between.
 *                  Level 1 hint at `hintAfter` failures, level 2 blocks that exact call at
 *                  `escalateAfter` until a file changes.
 *  - same error:   different attempts keep ending in the same error ("approach X failed 3x").
 *                  Level 1 hint, level 2 forced strategy change, level 3 tells the user.
 *  - repeat:       the identical call succeeds over and over without progress (e.g. re-reading
 *                  the same file). Level 1 hint only.
 *
 * The hard stop stays with the budget brake.
 */
import { createHash } from "node:crypto";
import type { Config } from "./config.js";
import { CALL_WINDOW, type CallRecord, type SessionState } from "./session.js";

export type LoopKind = "blind-retry" | "same-error" | "repeat";

export interface LoopEvent {
  kind: LoopKind;
  level: 1 | 2 | 3;
  label: string;
  count: number;
  error?: string;
}

const MUTATING_TOOLS = new Set(["edit", "multiedit", "write", "notebookedit", "apply_patch"]);

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object") {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

const shorten = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

/** What makes two calls "the same action". */
export function signature(tool: string, input: Record<string, unknown>): { sig: string; label: string } {
  const t = tool.toLowerCase();
  if (typeof input.command === "string") {
    const cmd = input.command.replace(/\s+/g, " ").trim();
    return { sig: `${t}:${hash(cmd)}`, label: shorten(cmd) };
  }
  const path = [input.file_path, input.notebook_path, input.path, input.url, input.pattern].find((v) => typeof v === "string") as string | undefined;
  return { sig: `${t}:${hash(stableStringify(input))}`, label: shorten(path ? `${tool} ${path}` : tool) };
}

/**
 * Normalize an error so that the same failure matches across attempts:
 * numbers, hex ids, paths and timings are blanked out.
 */
export function errorFingerprint(text: string): string {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const relevant = lines.filter((l) => /error|exception|failed|fatal|cannot|can't|not found|denied|traceback|assert|undefined|refused/i.test(l));
  const core = (relevant.length ? relevant : lines).slice(0, 3).join(" | ");
  const normalized = core
    .toLowerCase()
    .replace(/0x[0-9a-f]+/g, "H")
    .replace(/\b[0-9a-f]{7,}\b/g, "H")
    .replace(/([a-z]:)?[\\/][^\s:'"()]+/g, "P")
    .replace(/\d+(\.\d+)?/g, "N")
    .replace(/\s+/g, " ")
    .slice(0, 300);
  return normalized ? hash(normalized) : "";
}

function excerpt(text: string): string {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => /error|failed|exception|fatal|cannot|not found/i.test(l)) ?? text.trim().split(/\r?\n/)[0] ?? "";
  return shorten(line, 160);
}

/**
 * Extract an error from a successful-looking PostToolUse response. Returns null for success.
 * Claude Code reports most failures through PostToolUseFailure; this covers tools that return
 * an error payload instead.
 */
export function failureText(response: unknown): string | null {
  if (response == null) return null;
  if (typeof response === "string") {
    // Only the head of the output: a successful command may print "exit code 1" somewhere in its output.
    const head = response.trim().split(/\r?\n/).slice(0, 4).join("\n");
    return /^(error|failed)\b|^\s*(exit code|process exited with code)\s*:?\s*[1-9]|"exit_code"\s*:\s*[1-9]/im.test(head) ? response : null;
  }
  if (typeof response !== "object") return null;
  const r = response as Record<string, unknown>;
  const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  if (r.is_error === true || r.isError === true) return text(r.error ?? r.content ?? r);
  if (typeof r.error === "string" && r.error) return r.error;
  for (const key of ["exitCode", "exit_code", "returnCode"]) {
    const code = r[key];
    if (typeof code === "number" && code !== 0) return text(r.stderr || r.stdout || `exit code ${code}`);
  }
  if (r.success === false) return text(r.message ?? r);
  return null;
}

/** Calls after the most recent successful file change. */
function sinceLastChange(calls: CallRecord[]): CallRecord[] {
  for (let i = calls.length - 1; i >= 0; i--) if (calls[i]!.mutating) return calls.slice(i + 1);
  return calls;
}

/** Failures with this error since a call that used to produce it last succeeded (the error was fixed then). */
function countSameError(calls: CallRecord[], err: string): number {
  const producers = new Set(calls.filter((c) => !c.ok && c.err === err).map((c) => c.sig));
  let count = 0;
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]!;
    if (c.ok && producers.has(c.sig)) break;
    if (!c.ok && c.err === err) count++;
  }
  return count;
}

function announce(state: SessionState, key: string, level: number): boolean {
  if ((state.issued[key] ?? 0) >= level) return false;
  state.issued[key] = level;
  return true;
}

/**
 * Record a tool call when it starts, optimistically as a success. Agents only report failures
 * separately (PostToolUseFailure), so successful calls need no second hook process; a later
 * failure flips this record via `recordFailure`. Returns a "repeat" event if one is due.
 */
export function recordAttempt(
  state: SessionState,
  call: { tool: string; input: Record<string, unknown> },
  cfg: Config,
  /** The session's accounted cost so far, to price loop rounds for the savings report. */
  costAt?: number,
): LoopEvent | null {
  const { sig, label } = signature(call.tool, call.input);
  const mutating = MUTATING_TOOLS.has(call.tool.toLowerCase());
  state.callCount = (state.callCount ?? 0) + 1;
  state.calls.push({ sig, label, ok: true, mutating, at: Date.now(), ...(costAt !== undefined ? { costAt } : {}) });
  if (state.calls.length > CALL_WINDOW) state.calls.shift();
  if (mutating) {
    // Something changes: earlier failures may now succeed, so lift blind-retry blocks.
    state.blocked = {};
    for (const key of Object.keys(state.issued)) if (key.startsWith("blind:") || key.startsWith("repeat:")) delete state.issued[key];
    return null;
  }
  if (!cfg.loop.enabled) return null;
  const repeats = sinceLastChange(state.calls).filter((c) => c.sig === sig).length;
  if (repeats >= cfg.loop.repeatHintAfter && announce(state, `repeat:${sig}`, 1)) {
    return { kind: "repeat", level: 1, label, count: repeats };
  }
  return null;
}

/** A started call failed. Returns a loop event that should be announced now, if any. */
export function recordFailure(
  state: SessionState,
  call: { tool: string; input: Record<string, unknown>; error: string },
  cfg: Config,
): LoopEvent | null {
  // SteinWall's own blocks are not the agent's failures.
  if (/steinwall/i.test(call.error)) return null;
  const { sig, label } = signature(call.tool, call.input);
  let record = [...state.calls].reverse().find((c) => c.sig === sig && c.ok);
  if (!record) {
    record = { sig, label, ok: true, mutating: false, at: Date.now() };
    state.calls.push(record);
    if (state.calls.length > CALL_WINDOW) state.calls.shift();
  }
  Object.assign(record, { ok: false, mutating: false, err: errorFingerprint(call.error), errText: excerpt(call.error) });
  if (!cfg.loop.enabled) return null;
  const { hintAfter, escalateAfter, notifyUserAfter } = cfg.loop;
  const recent = sinceLastChange(state.calls);

  // Failures of this exact call since it last succeeded and since the last file change.
  let blind = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const c = recent[i]!;
    if (c.sig !== sig) continue;
    if (c.ok) break;
    blind++;
  }
  const sameError = record.err ? countSameError(state.calls, record.err) : 0;

  const candidates: LoopEvent[] = [];
  if (blind >= escalateAfter && announce(state, `blind:${sig}`, 2)) {
    state.blocked[sig] = { label, count: blind };
    candidates.push({ kind: "blind-retry", level: 2, label, count: blind, error: record.errText });
  } else if (blind >= hintAfter && announce(state, `blind:${sig}`, 1)) {
    candidates.push({ kind: "blind-retry", level: 1, label, count: blind, error: record.errText });
  }
  const errKey = `err:${record.err}`;
  if (record.err && sameError > blind) {
    const level = sameError >= notifyUserAfter ? 3 : sameError >= escalateAfter ? 2 : sameError >= hintAfter ? 1 : 0;
    if (level && announce(state, errKey, level)) {
      candidates.push({ kind: "same-error", level: level as 1 | 2 | 3, label, count: sameError, error: record.errText });
    }
  }
  const event = candidates.sort((a, b) => b.level - a.level)[0] ?? null;

  // A loop SteinWall already intervened in came back: not rescued (yet).
  for (const p of state.pending) if (p.key === `blind:${sig}` || p.key === errKey) p.lastSeen = state.callCount;
  if (event) {
    const key = event.kind === "blind-retry" ? `blind:${sig}` : errKey;
    const existing = state.pending.find((p) => p.key === key);
    if (event.level >= 3) {
      // The agent is stuck and the user was asked to step in: SteinWall did not rescue this one.
      state.pending = state.pending.filter((p) => p.key !== key);
    } else if (existing) {
      existing.level = Math.max(existing.level, event.level);
    } else {
      state.pending.push({ key, rounds: event.count, roundUsd: roundCost(state, event.kind === "blind-retry" ? (c) => c.sig === sig : (c) => c.err === record!.err), lastSeen: state.callCount, level: event.level });
    }
  }
  return event;
}

/**
 * Cost of one loop round: the session's cost between the first and the latest failed round,
 * divided by the rounds in between. Falls back to the session's average cost per call.
 */
function roundCost(state: SessionState, matches: (c: CallRecord) => boolean): number {
  const rounds = state.calls.filter((c) => !c.ok && matches(c) && c.costAt !== undefined);
  const first = rounds[0];
  const last = rounds[rounds.length - 1];
  if (first && last && rounds.length >= 2 && last.costAt! > first.costAt!) return (last.costAt! - first.costAt!) / (rounds.length - 1);
  const latest = [...state.calls].reverse().find((c) => c.costAt !== undefined);
  return latest && state.callCount > 0 ? latest.costAt! / state.callCount : 0;
}

/** Calls without a recurrence after which an intervened loop counts as rescued. */
export const RESCUE_QUIET_CALLS = 8;

/**
 * Credit loops that stayed quiet after SteinWall intervened. Savings assume, conservatively,
 * that the loop would have run at least as many more rounds as it had already run.
 * `turnEnded`: the agent finished its turn calmly; 2 quiet calls are enough then.
 */
export function settleRescues(state: SessionState, turnEnded = false): { usd: number; loops: number } {
  let usd = 0;
  let loops = 0;
  state.pending = (state.pending ?? []).filter((p) => {
    const quiet = state.callCount - p.lastSeen;
    if (quiet >= RESCUE_QUIET_CALLS || (turnEnded && quiet >= 2)) {
      usd += p.rounds * p.roundUsd;
      loops++;
      return false;
    }
    return true;
  });
  return { usd, loops };
}

/** Record a call whose outcome is already known (agents that report every result). */
export function recordOutcome(
  state: SessionState,
  call: { tool: string; input: Record<string, unknown>; error: string | null },
  cfg: Config,
): LoopEvent | null {
  if (call.error !== null && /steinwall/i.test(call.error)) return null;
  const attempt = recordAttempt(state, call, cfg);
  return call.error === null ? attempt : recordFailure(state, { ...call, error: call.error }, cfg);
}

/** A call the agent may not repeat right now, or null. */
export function blockedRepeat(state: SessionState, tool: string, input: Record<string, unknown>): { label: string; count: number } | null {
  return state.blocked[signature(tool, input).sig] ?? null;
}
