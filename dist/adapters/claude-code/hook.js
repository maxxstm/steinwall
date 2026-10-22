/**
 * Claude Code hook entry point. One script serves every event; Claude Code passes the event
 * as JSON on stdin. The hook must never break a session: any internal error is logged and the
 * tool call / prompt proceeds (fail-open), and the process always exits 0.
 */
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadConfig, resolveLanguage } from "../../core/config.js";
import { checkExtensions, creditProSavings, creditSavings, dailySummary, trialNotice, recordScan, recordGuardDecision, recordLoopEvent, refresh, updateToday, withSession } from "../../core/engine.js";
import { logError } from "../../core/fsutil.js";
import { checkToolCall } from "../../core/guard/index.js";
import { nearLimit, readHandoff, writeAutoSection } from "../../core/handoff.js";
import { parsePatch, patchText } from "../../core/guard/patch.js";
import { installCliLauncher } from "./launcher.js";
import { backgroundTasks, telemetryQuestionOnce } from "./background.js";
import { isPro } from "../../core/license.js";
import { checkCustomRules } from "../../core/rules.js";
import { contextAdvice, contextLevel, costCoach, crossToolHint, isScout, otherAgentWithSteinwall, readTextSafe, routingHint, routingSavings, trimOutput, trimSavings } from "../../core/pro.js";
import { messages } from "../../core/i18n.js";
import { blockedRepeat, failureText, recordAttempt, recordFailure, settleRescues } from "../../core/loops.js";
import { pluginRootFile } from "../../core/paths.js";
import { summarize } from "../../core/scanner/index.js";
import { checkInstall } from "../../core/scanner/intercept.js";
import { inventoryCheckedAt } from "../../core/scanner/inventory.js";
import { pruneSessions, rememberFile } from "../../core/session.js";
import { pluginRoot, readStdin } from "./io.js";
/** Modes in which Claude Code approves a hook's "ask" without showing the user a prompt. */
const UNATTENDED_MODES = new Set(["auto", "bypassPermissions", "dontAsk"]);
const FILE_TOOLS = new Set(["edit", "multiedit", "write", "notebookedit"]);
const HANDOFF_MAX_AGE_MS = 30 * 24 * 3600 * 1000;
const INVENTORY_RECHECK_MS = 10 * 60 * 1000;
export function handleHook(input, cfg, lang) {
    const session = { transcriptPath: input.transcript_path, sessionId: input.session_id };
    switch (input.hook_event_name) {
        case "PreToolUse":
            return preToolUse(input, cfg, lang, session);
        case "PostToolUse":
        case "PostToolUseFailure":
            return postToolUse(input, cfg, lang);
        case "UserPromptSubmit":
            return userPromptSubmit(input, cfg, lang, session);
        case "SessionStart":
            return sessionStart(input, cfg, lang, session);
        case "Stop":
            return stop(input, cfg, lang, session);
        case "SubagentStop":
            return subagentStop(input, cfg, lang, session);
        default:
            return null;
    }
}
function preToolUse(input, cfg, lang, session) {
    const tool = input.tool_name ?? "";
    const toolInput = input.tool_input ?? {};
    // Pro: project rules from .steinwall/rules.json add denies/asks; an "allow" rule skips the
    // built-in guard for that command (never SteinWall's self-protection).
    const custom = safe(() => (isPro() ? checkCustomRules(tool, toolInput, input.cwd) : null));
    let guard = checkToolCall({ tool, input: toolInput }, cfg);
    if (custom === "allow" && guard && guard.rule !== "self-protect")
        guard = null;
    if (guard?.decision === "deny") {
        safe(() => recordGuardDecision("deny"));
        return permission("deny", messages.guardDeny(lang, guard.rule, guard.subject));
    }
    if (custom && custom !== "allow" && custom.decision === "deny") {
        safe(() => recordGuardDecision("deny"));
        return permission("deny", messages.customDeny(lang, custom.reason));
    }
    const customAsk = custom && custom !== "allow" && custom.decision === "ask" ? messages.customAsk(lang, custom.reason) : null;
    const snap = safeRefresh(cfg, session);
    const exceeded = snap?.budget.worst?.state === "exceeded" ? snap.budget.worst : null;
    if (snap?.budget.enforced && exceeded)
        return permission("deny", messages.budgetExceeded(lang, exceeded));
    const repeat = cfg.loop.enabled ? safe(() => withSession(input.session_id, (s) => blockedRepeat(s, tool, toolInput))) : null;
    if (repeat)
        return permission("deny", messages.loopBlocked(lang, repeat.label, repeat.count));
    // Extension installs (MCP servers, plugins, skills) are scanned before they land.
    const install = cfg.scanner.enabled ? safe(() => checkInstall(tool, toolInput, input.cwd)) : null;
    if (install) {
        safe(() => withSession(input.session_id, (s) => {
            s.inventoryDirty = true;
        }));
    }
    const scan = install?.result;
    if (scan)
        safe(() => recordScan(scan.verdict));
    if (scan?.verdict === "block")
        return permission("deny", messages.scanBlocked(lang, install.target, summarize(scan.findings)));
    const scanAsk = scan?.verdict === "warn" ? messages.scanAsk(lang, install.target, summarize(scan.findings)) : null;
    const note = announcement(snap, lang);
    // Codex hooks cannot ask for approval at all; in auto/bypass modes an ask would be approved unseen.
    const canAsk = input.agent !== "codex" && !UNATTENDED_MODES.has(input.permission_mode ?? "");
    const why = input.agent === "codex" ? "codex" : (input.permission_mode ?? "");
    let guardAsk = guard?.decision === "ask" ? guard : null;
    let pendingScanAsk = scanAsk;
    let pendingCustomAsk = customAsk;
    if (!canAsk && cfg.guard.unattendedAsk === "deny") {
        if (guardAsk) {
            safe(() => recordGuardDecision("deny"));
            return { ...permission("deny", messages.guardUnattended(lang, guardAsk.rule, guardAsk.subject, why)), ...note };
        }
        if (pendingScanAsk)
            return { ...permission("deny", messages.scanUnattended(lang, pendingScanAsk, why)), ...note };
        if (pendingCustomAsk) {
            safe(() => recordGuardDecision("deny"));
            return { ...permission("deny", messages.askUnattended(lang, pendingCustomAsk, why)), ...note };
        }
    }
    else if (!canAsk && input.agent === "codex") {
        // Configured to trust the agent, and Codex cannot show a prompt: let it run.
        guardAsk = null;
        pendingScanAsk = null;
        pendingCustomAsk = null;
    }
    // The call will run: record it now (successful calls get no second hook run) and add hints.
    const context = safe(() => withSession(input.session_id, (s) => {
        if (input.cwd)
            s.cwd = input.cwd;
        if (snap?.mainModel)
            s.mainModel = snap.mainModel;
        for (const path of changedFiles(tool, toolInput))
            rememberFile(s, path);
        const event = recordAttempt(s, { tool, input: toolInput }, cfg, snap?.day.sessions[input.session_id ?? "unknown"]);
        return { event, rescue: settleRescues(s), nudge: handoffNudge(s, input.cwd, cfg, lang, input.agent) };
    }));
    if (context?.event)
        safe(() => recordLoopEvent(context.event.level));
    if (context)
        afterSessionUpdate(context);
    const additionalContext = [context?.event && messages.loop(lang, context.event), context?.nudge].filter(Boolean).join("\n\n");
    let out = null;
    if (guardAsk) {
        safe(() => recordGuardDecision("ask"));
        out = permission("ask", messages.guardAsk(lang, guardAsk.rule, guardAsk.subject));
    }
    else if (pendingCustomAsk) {
        safe(() => recordGuardDecision("ask"));
        out = permission("ask", pendingCustomAsk);
    }
    else if (pendingScanAsk) {
        out = permission("ask", pendingScanAsk);
    }
    if (additionalContext) {
        const specific = out?.hookSpecificOutput ?? { hookEventName: "PreToolUse" };
        out = { ...out, hookSpecificOutput: { ...specific, additionalContext } };
    }
    return out || note ? { ...out, ...note } : null;
}
function postToolUse(input, cfg, lang) {
    const tool = input.tool_name ?? "";
    const toolInput = input.tool_input ?? {};
    // Successes were recorded at PreToolUse; only a failure changes the picture.
    const error = input.hook_event_name === "PostToolUseFailure" ? input.error || "tool call failed" : failureText(input.tool_response);
    const trim = trimmedOutput(input, cfg, lang);
    if (error === null)
        return trim ? { decision: "block", reason: trim } : null;
    const result = safe(() => withSession(input.session_id, (s) => ({
        event: recordFailure(s, { tool, input: toolInput, error }, cfg),
        nudge: handoffNudge(s, input.cwd, cfg, lang, input.agent),
    })));
    if (!result)
        return trim ? { decision: "block", reason: trim } : null;
    if (result.event)
        safe(() => recordLoopEvent(result.event.level));
    afterSessionUpdate(result);
    const context = [result.event && messages.loop(lang, result.event), result.nudge].filter(Boolean).join("\n\n");
    const out = context ? withContext(input.hook_event_name, context, loopUserMessage(result.event, lang)) : null;
    return trim ? { ...out, decision: "block", reason: trim } : out;
}
/**
 * Pro, Codex only: a huge tool output is replaced by its head and tail before it enters the
 * context (Codex uses a PostToolUse "block" reason as the new tool result). Claude Code has no
 * equivalent for built-in tools.
 */
function trimmedOutput(input, cfg, lang) {
    if (input.agent !== "codex" || !cfg.pro.outputTrim)
        return null;
    const r = input.tool_response;
    const text = typeof r === "string" ? r : r && typeof r === "object" && typeof r.output === "string" ? r.output : null;
    if (!text || text.length <= cfg.pro.outputTrimChars || !safe(() => isPro()))
        return null;
    const t = trimOutput(text, cfg.pro.outputTrimChars, lang);
    if (!t)
        return null;
    safe(() => creditProSavings("trim", trimSavings(t.removed, input.model ?? "gpt-6.1-sol")));
    return t.text;
}
/** Pro routing: a finished scout subagent is credited with the price difference to the main model. */
function subagentStop(input, cfg, lang, session) {
    const note = announcement(safeRefresh(cfg, session), lang);
    if (input.agent === "codex" || !cfg.pro.routing)
        return note;
    safe(() => {
        if (!isPro())
            return;
        const path = input.agent_transcript_path ?? newestSubagentTranscript(input.transcript_path, input.session_id);
        const text = readTextSafe(path);
        if (!path || !text || !isScout(input.agent_type, text))
            return;
        const credit = withSession(input.session_id, (s) => {
            s.routedTranscripts ??= [];
            if (!s.mainModel || s.routedTranscripts.includes(path))
                return 0;
            s.routedTranscripts.push(path);
            return routingSavings(text, s.mainModel).saved;
        });
        creditProSavings("routing", credit);
    });
    return note;
}
function newestSubagentTranscript(transcriptPath, sessionId) {
    if (!transcriptPath || !sessionId)
        return undefined;
    const dir = join(dirname(transcriptPath), sessionId, "subagents");
    try {
        return readdirSync(dir)
            .filter((f) => f.endsWith(".jsonl"))
            .map((f) => join(dir, f))
            .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    }
    catch {
        return undefined;
    }
}
function userPromptSubmit(input, cfg, lang, session) {
    // Never lock the user out of the commands that lift the stop.
    if (input.prompt?.trim().startsWith("/steinwall"))
        return null;
    const snap = safeRefresh(cfg, session);
    const exceeded = snap?.budget.worst?.state === "exceeded" ? snap.budget.worst : null;
    if (snap?.budget.enforced && exceeded)
        return { decision: "block", reason: messages.budgetPromptBlocked(lang, exceeded) };
    const pro = safe(() => isPro()) ?? false;
    const model = snap?.mainModel ?? input.model;
    const result = safe(() => withSession(input.session_id, (s) => {
        if (input.cwd)
            s.cwd = input.cwd;
        if (input.prompt)
            s.lastPrompt = input.prompt.trim().slice(0, 500);
        // Pro: the context advisor speaks once per 50K tokens of growth above the threshold.
        let advice = null;
        const tokens = snap?.contextTokens ?? 0;
        const level = contextLevel(tokens, cfg.pro.contextWarnTokens);
        if (pro && cfg.pro.contextAdvisor && model && level > (s.contextWarnLevel ?? 0)) {
            advice = contextAdvice(lang, model, tokens, input.agent ?? "claude", s.lastPrompt?.split(/[.?!\n]/)[0]);
        }
        s.contextWarnLevel = level; // also lowers it after a compaction
        return { nudge: handoffNudge(s, input.cwd, cfg, lang, input.agent), advice };
    }));
    if (result?.nudge)
        afterSessionUpdate({ nudge: result.nudge });
    const coach = pro && cfg.pro.costCoach && model && input.prompt ? costCoach(lang, model, snap?.contextTokens ?? 0, input.prompt) : null;
    const userMessages = [announcement(snap, lang)?.systemMessage, result?.advice, coach].filter(Boolean);
    const note = userMessages.length ? { systemMessage: userMessages.join("\n") } : null;
    return result?.nudge ? { ...withContext("UserPromptSubmit", result.nudge), ...note } : note;
}
function sessionStart(input, cfg, lang, session) {
    // The status line launcher follows the Claude Code installation; the CLI launcher serves both agents.
    if (input.agent !== "codex")
        rememberPluginRoot();
    safe(() => installCliLauncher());
    safe(() => pruneSessions());
    const budgetNote = announcement(safeRefresh(cfg, session), lang);
    // Yesterday in one line, once per day, at the first session start: a moment of visible value, no popup.
    const summary = safe(() => dailySummary(cfg, lang));
    // The best upgrade moment is the end of the trial, with the user's own measured Pro savings.
    const trial = safe(() => trialNotice(lang));
    // Extensions installed since the last check (also outside SteinWall's view, e.g. via /plugin).
    const ext = cfg.scanner.enabled ? safe(() => checkExtensions(input.cwd, cfg.scanner)) : null;
    // Licensing and opt-in telemetry run in the background so they never delay the session.
    safe(() => backgroundTasks(cfg));
    const systemMessage = [budgetNote?.systemMessage, summary, trial, flaggedUserMessage(ext?.flagged, lang), safe(() => telemetryQuestionOnce(cfg, lang))].filter(Boolean).join("\n");
    const note = systemMessage ? { systemMessage } : null;
    const contexts = [];
    if (ext?.flaggedNames.length)
        contexts.push(messages.scanFlaggedAgent(lang, ext.flaggedNames));
    // Pro routing: tell the agent about the cheap scout subagent (Claude Code only).
    if (input.agent !== "codex" && cfg.pro.routing && safe(() => isPro()))
        contexts.push(routingHint(lang));
    if (cfg.handoff.enabled && input.cwd && input.source !== "compact") {
        const info = safe(() => readHandoff(input.cwd));
        if (info && info.status === "open" && Date.now() - info.updatedAt <= HANDOFF_MAX_AGE_MS)
            contexts.push(messages.handoffResume(lang, info.path, info.updatedAt));
    }
    return contexts.length ? { ...withContext("SessionStart", contexts.join("\n\n")), ...note } : note;
}
function flaggedUserMessage(flagged, lang) {
    if (!flagged?.length)
        return null;
    return messages.scanFlaggedUser(lang, flagged.map((f) => ({ name: f.item.name, kind: f.item.kind, summary: summarize(f.findings, 1) })));
}
/** After an install attempt (or every 10 minutes), check what is installed now. */
function extensionsAtTurnEnd(input, cfg, lang) {
    if (!cfg.scanner.enabled)
        return null;
    const dirty = safe(() => withSession(input.session_id, (s) => {
        const d = !!s.inventoryDirty;
        s.inventoryDirty = false;
        return d;
    }));
    if (!dirty && Date.now() - (safe(() => inventoryCheckedAt()) ?? 0) < INVENTORY_RECHECK_MS)
        return null;
    return flaggedUserMessage(safe(() => checkExtensions(input.cwd, cfg.scanner))?.flagged, lang);
}
function stop(input, cfg, lang, session) {
    const snap = safeRefresh(cfg, session);
    // The turn ended calmly: loops that stayed quiet since SteinWall intervened count as rescued.
    const rescue = safe(() => withSession(input.session_id, (s) => settleRescues(s, true)));
    if (rescue)
        afterSessionUpdate({ rescue });
    const messagesToUser = [announcement(snap, lang)?.systemMessage, extensionsAtTurnEnd(input, cfg, lang)].filter(Boolean);
    const note = messagesToUser.length ? { systemMessage: messagesToUser.join("\n") } : null;
    if (!cfg.handoff.enabled || !input.cwd)
        return note;
    const cwd = input.cwd;
    // Fallback without limit data: the limit already hit, so SteinWall saves what it knows itself.
    if (snap?.limitHit) {
        const path = safe(() => withSession(input.session_id, (s) => writeAutoSection(cwd, s, "usage limit reached")));
        if (path)
            afterSessionUpdate({ nudge: path });
        return path ? { systemMessage: messages.handoffSaved(lang, path) + crossTool(input.agent, lang) } : note;
    }
    // Near the limit and the agent has not written the handoff yet: keep it going once to do so.
    if (input.stop_hook_active)
        return note;
    const reason = safe(() => withSession(input.session_id, (s) => {
        const near = nearLimit(cfg, Date.now(), input.agent ?? "claude");
        if (!near || s.handoff.stopBlockedKey === near.key)
            return null;
        const info = readHandoff(cwd);
        if (info && s.handoff.nudgedAt && info.updatedAt > s.handoff.nudgedAt + 1000)
            return null;
        const firstRequest = s.handoff.nudgedKey !== near.key;
        s.handoff.stopBlockedKey = near.key;
        s.handoff.nudgedKey = near.key;
        s.handoff.nudgedAt = Date.now();
        return { text: messages.handoffNudge(lang, near, writeAutoSection(cwd, s, "limit warning")), firstRequest };
    }));
    if (reason?.firstRequest)
        afterSessionUpdate({ nudge: reason.text });
    return reason ? { decision: "block", reason: reason.text } : note;
}
/** Files a tool call writes: file_path for Claude's tools, the patch's files for Codex's apply_patch. */
function changedFiles(tool, input) {
    const t = tool.toLowerCase();
    if (t === "apply_patch") {
        const text = patchText(input);
        return text ? parsePatch(text).filter((f) => f.op !== "delete").map((f) => f.moveTo ?? f.path) : [];
    }
    const path = input.file_path ?? input.notebook_path;
    return FILE_TOOLS.has(t) && typeof path === "string" ? [path] : [];
}
/** Day-level bookkeeping after a session update (outside the session lock). */
function afterSessionUpdate(r) {
    if (r.rescue?.loops)
        safe(() => creditSavings(r.rescue));
    if (r.nudge) {
        safe(() => updateToday((d) => {
            d.handoffs++;
        }));
    }
}
/** Once per limit window: create the handoff file and return the instruction to fill it in. */
function handoffNudge(s, cwd, cfg, lang, agent = "claude") {
    if (!cwd)
        return null;
    const near = nearLimit(cfg, Date.now(), agent);
    if (!near || s.handoff.nudgedKey === near.key)
        return null;
    s.handoff.nudgedKey = near.key;
    s.handoff.nudgedAt = Date.now();
    const path = writeAutoSection(cwd, s, "limit warning");
    return messages.handoffNudge(lang, near, path) + crossTool(agent, lang);
}
/** Pro: when SteinWall is also installed in the other agent, the handoff can continue there. */
function crossTool(agent, lang) {
    const other = safe(() => (isPro() ? otherAgentWithSteinwall(agent ?? "claude") : null));
    return other ? crossToolHint(lang, other) : "";
}
function loopUserMessage(event, lang) {
    return event && event.level === 3 ? messages.loopUser(lang, event) : undefined;
}
function withContext(event, additionalContext, systemMessage) {
    return { hookSpecificOutput: { hookEventName: event, additionalContext }, ...(systemMessage ? { systemMessage } : {}) };
}
function permission(decision, reason) {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision, permissionDecisionReason: reason } };
}
function announcement(snap, lang) {
    if (!snap?.announce)
        return null;
    return { systemMessage: messages.budgetWarn(lang, snap.announce, snap.budget.enforced) };
}
function safeRefresh(cfg, session) {
    return safe(() => refresh(cfg, session, { notify: true }));
}
function safe(fn) {
    try {
        return fn();
    }
    catch (err) {
        logError("hook", err);
        return null;
    }
}
/** The status line launcher in ~/.steinwall finds the current plugin version through this file. */
function rememberPluginRoot() {
    safe(() => {
        mkdirSync(dirname(pluginRootFile()), { recursive: true });
        writeFileSync(pluginRootFile(), pluginRoot());
    });
}
export async function runHook(agent = "claude") {
    try {
        const raw = await readStdin();
        if (!raw.trim())
            return;
        const cfg = loadConfig();
        const out = handleHook({ ...JSON.parse(raw), agent }, cfg, resolveLanguage(cfg));
        if (out)
            process.stdout.write(JSON.stringify(out));
    }
    catch (err) {
        logError("hook", err);
    }
}
