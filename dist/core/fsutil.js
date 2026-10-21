import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { errorLog, lockDir } from "./paths.js";
export function readJson(file, fallback) {
    try {
        return JSON.parse(readFileSync(file, "utf8"));
    }
    catch {
        return fallback;
    }
}
/** Write via temp file + rename so a crashed hook never leaves half-written JSON behind. */
export function writeJson(file, data) {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    for (let attempt = 0;; attempt++) {
        try {
            renameSync(tmp, file);
            return;
        }
        catch (err) {
            // Windows: rename fails with EPERM/EBUSY while another process has the target open.
            if (attempt >= 8) {
                rmSync(tmp, { force: true });
                throw err;
            }
            sleep(10 * (attempt + 1));
        }
    }
}
const sleeper = new Int32Array(new SharedArrayBuffer(4));
export function sleep(ms) {
    Atomics.wait(sleeper, 0, 0, ms);
}
const LOCK_STALE_MS = 5_000;
const LOCK_TIMEOUT_MS = 3_000;
/**
 * Cross-process mutex (several Claude sessions run hooks in parallel).
 * mkdir is atomic on every platform; a lock older than LOCK_STALE_MS is assumed abandoned.
 */
export function withLock(fn) {
    const dir = lockDir();
    mkdirSync(dirname(dir), { recursive: true });
    const start = Date.now();
    for (;;) {
        try {
            mkdirSync(dir);
            break;
        }
        catch (err) {
            if (err.code !== "EEXIST")
                throw err;
            try {
                if (Date.now() - statSync(dir).mtimeMs > LOCK_STALE_MS) {
                    rmSync(dir, { recursive: true, force: true });
                    continue;
                }
            }
            catch {
                continue; // lock vanished between mkdir and stat
            }
            if (Date.now() - start > LOCK_TIMEOUT_MS)
                throw new Error("steinwall: timed out waiting for state lock");
            sleep(15);
        }
    }
    try {
        return fn();
    }
    finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
export function logError(context, err) {
    try {
        mkdirSync(dirname(errorLog()), { recursive: true });
        const text = err instanceof Error ? (err.stack ?? err.message) : String(err);
        appendFileSync(errorLog(), `${new Date().toISOString()} [${context}] ${text}\n`);
    }
    catch {
        // Logging must never break the agent.
    }
}
/** Local calendar day (YYYY-MM-DD); budgets reset at local midnight, not UTC. */
export function localDay(d = new Date()) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
