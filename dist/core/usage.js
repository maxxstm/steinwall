import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { cursorsFile, usageDir } from "./paths.js";
import { localDay, readJson, writeJson } from "./fsutil.js";
import { LIMIT_HIT_PATTERN } from "./handoff.js";
import { costUsd, normalizeModel, priceFor, ZERO_USAGE } from "./pricing.js";
export function emptyDay(date) {
    return {
        date,
        costUsd: 0,
        tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
        byModel: {},
        sessions: {},
        guard: { denied: 0, asked: 0 },
        loops: { hints: 0, blocks: 0 },
        savings: { usd: 0, loopsRescued: 0 },
        byHour: {},
        handoffs: 0,
        scans: { items: 0, flagged: 0, blocked: 0 },
        flags: {},
        unknownModels: [],
    };
}
const dayFile = (date) => join(usageDir(), `${date}.json`);
export function loadDay(date = localDay()) {
    return { ...emptyDay(date), ...readJson(dayFile(date), {}) };
}
export function saveDay(day) {
    writeJson(dayFile(day.date), day);
}
/** Call only while holding the state lock. */
export function updateDay(date, fn) {
    const day = loadDay(date);
    fn(day);
    saveDay(day);
    return day;
}
export function monthCost(month) {
    let files;
    try {
        files = readdirSync(usageDir());
    }
    catch {
        return 0;
    }
    return files
        .filter((f) => f.startsWith(month) && f.endsWith(".json"))
        .reduce((sum, f) => sum + loadDay(f.slice(0, -5)).costUsd, 0);
}
const SEEN_LIMIT = 200;
const CURSOR_TTL_MS = 45 * 24 * 3600 * 1000;
function toUsage(u) {
    const split = u.cache_creation;
    const hasSplit = split && (split.ephemeral_5m_input_tokens !== undefined || split.ephemeral_1h_input_tokens !== undefined);
    return {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite5m: hasSplit ? (split.ephemeral_5m_input_tokens ?? 0) : (u.cache_creation_input_tokens ?? 0),
        cacheWrite1h: hasSplit ? (split.ephemeral_1h_input_tokens ?? 0) : 0,
    };
}
const fields = Object.keys(ZERO_USAGE);
const maxUsage = (a, b) => Object.fromEntries(fields.map((f) => [f, Math.max(a[f], b[f])]));
const diffUsage = (a, b) => Object.fromEntries(fields.map((f) => [f, Math.max(0, a[f] - b[f])]));
/** Subagent transcripts live next to the session transcript in <sessionId>/subagents/*.jsonl. */
function sessionFiles(transcriptPath, sessionId) {
    const files = [transcriptPath];
    const sessionDir = join(dirname(transcriptPath), sessionId || basename(transcriptPath, ".jsonl"), "subagents");
    try {
        for (const f of readdirSync(sessionDir))
            if (f.endsWith(".jsonl"))
                files.push(join(sessionDir, f));
    }
    catch {
        // no subagents yet
    }
    return files;
}
export function ingestSession(transcriptPath, sessionId) {
    if (!transcriptPath)
        return { addedUsd: 0, limitHit: false };
    const cursors = readJson(cursorsFile(), { files: {} });
    const days = new Map();
    const now = Date.now();
    let added = 0;
    let limitHit = false;
    let codexRateLimits;
    for (const file of sessionFiles(transcriptPath, sessionId)) {
        const cursor = cursors.files[file] ?? { offset: 0, seen: {}, order: [], lastSeen: now };
        cursors.files[file] = cursor;
        cursor.lastSeen = now;
        for (const line of readNewLines(file, cursor)) {
            const r = accountLine(line, cursor, sessionId, days);
            added += r.usd;
            if (r.codexRateLimits)
                codexRateLimits = r.codexRateLimits;
            if (r.limitHit || (line.includes("isApiErrorMessage") && LIMIT_HIT_PATTERN.test(line)))
                limitHit = true;
        }
    }
    for (const [file, cursor] of Object.entries(cursors.files)) {
        if (now - cursor.lastSeen > CURSOR_TTL_MS)
            delete cursors.files[file];
    }
    for (const day of days.values())
        saveDay(day);
    writeJson(cursorsFile(), cursors);
    const main = cursors.files[transcriptPath];
    return {
        addedUsd: added,
        limitHit,
        ...(codexRateLimits ? { codexRateLimits } : {}),
        ...(main?.model ? { mainModel: main.model } : {}),
        ...(main?.lastPrompt ? { contextTokens: main.lastPrompt } : {}),
    };
}
function readNewLines(file, cursor) {
    let size;
    try {
        size = statSync(file).size;
    }
    catch {
        return [];
    }
    if (size < cursor.offset)
        cursor.offset = 0; // file was rewritten; message ids prevent double counting
    if (size === cursor.offset)
        return [];
    const buf = Buffer.alloc(size - cursor.offset);
    const fd = openSync(file, "r");
    try {
        readSync(fd, buf, 0, buf.length, cursor.offset);
    }
    finally {
        closeSync(fd);
    }
    const end = buf.lastIndexOf(0x0a);
    if (end < 0)
        return []; // only a partial line so far
    cursor.offset += end + 1;
    return buf.subarray(0, end).toString("utf8").split("\n");
}
function parse(line) {
    try {
        return JSON.parse(line);
    }
    catch {
        return null;
    }
}
function accountLine(line, cursor, sessionId, days) {
    if (line.includes('"turn_context"') || line.includes('"token_count"'))
        return accountCodexLine(line, cursor, sessionId, days);
    if (!line.includes('"usage"'))
        return { usd: 0 };
    const entry = parse(line);
    const msg = entry?.message;
    if (!entry || entry.type !== "assistant" || !msg?.usage || !msg.model || msg.model === "<synthetic>")
        return { usd: 0 };
    const usage = toUsage(msg.usage);
    const key = `${msg.id ?? entry.uuid ?? ""}:${entry.requestId ?? ""}`;
    const prev = cursor.seen[key];
    const fast = msg.usage.speed === "fast";
    const cost = Math.max(0, costUsd(msg.model, usage, { fast }) - (prev ? costUsd(msg.model, prev, { fast }) : 0));
    const delta = prev ? diffUsage(usage, prev) : usage;
    if (!prev)
        cursor.order.push(key);
    cursor.seen[key] = prev ? maxUsage(prev, usage) : usage;
    while (cursor.order.length > SEEN_LIMIT)
        delete cursor.seen[cursor.order.shift()];
    cursor.model = msg.model;
    cursor.lastPrompt = usage.input + usage.cacheRead + usage.cacheWrite5m + usage.cacheWrite1h;
    if (cost === 0 && fields.every((f) => delta[f] === 0))
        return { usd: 0 };
    return { usd: book(days, entry.timestamp, msg.model, delta, cost, sessionId) };
}
/**
 * Codex rollout files: `turn_context` carries the model, `event_msg/token_count` the usage of the
 * latest request (`last_token_usage`) and a running total. Token events can repeat; the running
 * total tells new ones from repeats. OpenAI's input_tokens include cached tokens.
 */
function accountCodexLine(line, cursor, sessionId, days) {
    const entry = parse(line);
    const p = entry?.payload;
    if (!entry || !p)
        return { usd: 0 };
    if (entry.type === "turn_context") {
        if (p.model)
            cursor.model = p.model;
        return { usd: 0 };
    }
    if (entry.type !== "event_msg" || p.type !== "token_count")
        return { usd: 0 };
    const result = { usd: 0, codexRateLimits: p.rate_limits, limitHit: !!p.rate_limits?.rate_limit_reached_type };
    const last = p.info?.last_token_usage;
    const total = p.info?.total_token_usage?.total_tokens ?? 0;
    if (!last || total === (cursor.codexTotal ?? 0))
        return result; // repeat of the previous event
    cursor.codexTotal = total; // a smaller total means a new counter (e.g. a new thread): count it too
    const cached = last.cached_input_tokens ?? 0;
    const cacheWrite = last.cache_write_input_tokens ?? 0;
    const usage = {
        input: Math.max(0, (last.input_tokens ?? 0) - cached - cacheWrite),
        cacheRead: cached,
        cacheWrite5m: cacheWrite,
        cacheWrite1h: 0,
        output: last.output_tokens ?? 0,
    };
    const model = cursor.model ?? "gpt-unknown";
    cursor.lastPrompt = last.input_tokens ?? 0;
    result.usd = book(days, entry.timestamp, model, usage, costUsd(model, usage), sessionId);
    return result;
}
/** Add one request's usage and cost to the day it happened on. */
function book(days, timestamp, rawModel, delta, cost, sessionId) {
    const ts = timestamp ? new Date(timestamp) : new Date();
    const when = Number.isNaN(ts.getTime()) ? new Date() : ts;
    const date = localDay(when);
    let day = days.get(date);
    if (!day)
        days.set(date, (day = loadDay(date)));
    const model = normalizeModel(rawModel);
    day.costUsd += cost;
    day.tokens.input += delta.input;
    day.tokens.output += delta.output;
    day.tokens.cacheWrite += delta.cacheWrite5m + delta.cacheWrite1h;
    day.tokens.cacheRead += delta.cacheRead;
    day.byModel[model] = (day.byModel[model] ?? 0) + cost;
    const hour = String(when.getHours());
    day.byHour[hour] = (day.byHour[hour] ?? 0) + cost;
    day.sessions[sessionId] = (day.sessions[sessionId] ?? 0) + cost;
    if (!priceFor(model).known && !day.unknownModels.includes(model))
        day.unknownModels.push(model);
    return cost;
}
