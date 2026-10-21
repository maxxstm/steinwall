import { readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./paths.js";
import { readJson, writeJson } from "./fsutil.js";
export const CALL_WINDOW = 40;
const FILE_LIMIT = 50;
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const sessionsDir = () => join(stateDir(), "sessions");
const sessionFile = (id) => join(sessionsDir(), `${id.replace(/[^\w.-]/g, "_") || "unknown"}.json`);
export function emptySession(id) {
    return { id, updatedAt: Date.now(), calls: [], blocked: {}, issued: {}, files: [], callCount: 0, pending: [], handoff: {} };
}
export function loadSession(id) {
    return { ...emptySession(id), ...readJson(sessionFile(id), {}) };
}
export function saveSession(s) {
    s.updatedAt = Date.now();
    if (s.calls.length > CALL_WINDOW)
        s.calls = s.calls.slice(-CALL_WINDOW);
    if (s.files.length > FILE_LIMIT)
        s.files = s.files.slice(-FILE_LIMIT);
    writeJson(sessionFile(s.id), s);
}
export function rememberFile(s, path) {
    s.files = s.files.filter((f) => f !== path);
    s.files.push(path);
}
/** Drop session files nobody touched for a week. Cheap enough to run on every session start. */
export function pruneSessions(now = Date.now()) {
    let names;
    try {
        names = readdirSync(sessionsDir());
    }
    catch {
        return;
    }
    for (const name of names) {
        const file = join(sessionsDir(), name);
        try {
            if (now - statSync(file).mtimeMs > SESSION_TTL_MS)
                rmSync(file, { force: true });
        }
        catch {
            // raced with another session
        }
    }
}
