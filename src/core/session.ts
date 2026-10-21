import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./paths.js";
import { readJson, writeJson } from "./fsutil.js";

/** One tool call as remembered for loop detection. */
export interface CallRecord {
  sig: string;
  label: string;
  ok: boolean;
  /** Error fingerprint for failed calls. */
  err?: string;
  /** Short error excerpt for messages. */
  errText?: string;
  /** A successful call that changed files: retrying something after this is not "blind". */
  mutating: boolean;
  at: number;
  /** The session's accounted cost when the call started (USD), to price loop rounds. */
  costAt?: number;
}

/** A loop SteinWall intervened in; credited as savings once the pattern stays quiet. */
export interface PendingRescue {
  key: string;
  /** Failed rounds when SteinWall first intervened. */
  rounds: number;
  /** Estimated cost of one round (USD). */
  roundUsd: number;
  /** callCount at the most recent recurrence. */
  lastSeen: number;
  level: number;
}

/** Per-session memory shared by loop rescue and the limit handoff. Only ever read and written under the state lock. */
export interface SessionState {
  id: string;
  cwd?: string;
  updatedAt: number;
  calls: CallRecord[];
  /** Calls blocked for blind retrying, by signature, until a file changes. */
  blocked: Record<string, { label: string; count: number }>;
  /** Highest loop level already announced per pattern key, so each message appears once. */
  issued: Record<string, number>;
  /** Files changed in this session (for the handoff), most recent last. */
  files: string[];
  lastPrompt?: string;
  /** Tool calls started in this session. */
  callCount: number;
  /** An extension install was attempted: re-check the inventory at the end of the turn. */
  inventoryDirty?: boolean;
  /** Pro: main model of the conversation, last context-advice level, credited scout transcripts. */
  mainModel?: string;
  contextWarnLevel?: number;
  routedTranscripts?: string[];
  pending: PendingRescue[];
  handoff: { nudgedKey?: string; nudgedAt?: number; stopBlockedKey?: string; resumeShown?: boolean };
}

export const CALL_WINDOW = 40;
const FILE_LIMIT = 50;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

const sessionsDir = () => join(stateDir(), "sessions");
const sessionFile = (id: string) => join(sessionsDir(), `${id.replace(/[^\w.-]/g, "_") || "unknown"}.json`);

export function emptySession(id: string): SessionState {
  return { id, updatedAt: Date.now(), calls: [], blocked: {}, issued: {}, files: [], callCount: 0, pending: [], handoff: {} };
}

export function loadSession(id: string): SessionState {
  return { ...emptySession(id), ...readJson<Partial<SessionState>>(sessionFile(id), {}) };
}

export function saveSession(s: SessionState): void {
  s.updatedAt = Date.now();
  if (s.calls.length > CALL_WINDOW) s.calls = s.calls.slice(-CALL_WINDOW);
  if (s.files.length > FILE_LIMIT) s.files = s.files.slice(-FILE_LIMIT);
  writeJson(sessionFile(s.id), s);
}

export function rememberFile(s: SessionState, path: string): void {
  s.files = s.files.filter((f) => f !== path);
  s.files.push(path);
}

/** Drop session files nobody touched for a week. Cheap enough to run on every session start. */
export function pruneSessions(now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(sessionsDir());
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(sessionsDir(), name);
    try {
      if (now - statSync(file).mtimeMs > SESSION_TTL_MS) rmSync(file, { force: true });
    } catch {
      // raced with another session
    }
  }
}
