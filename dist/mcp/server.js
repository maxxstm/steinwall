/**
 * Minimal MCP server (stdio, JSON-RPC 2.0, no dependencies) so SteinWall can be listed in MCP
 * registries and used from any MCP client: `steinwall mcp`. Read-only tools only: status, report,
 * scan. The plugins do not register it by default, because every MCP tool adds to the agent's
 * context and cost.
 */
import { createInterface } from "node:readline";
import { loadConfig, resolveLanguage } from "../core/config.js";
import { evaluateBudget } from "../core/budget.js";
import { localDay } from "../core/fsutil.js";
import { buildReport } from "../core/report.js";
import { scanPath, summarize } from "../core/scanner/index.js";
import { loadDay, monthCost } from "../core/usage.js";
const PROTOCOL = "2025-06-18";
export const TOOLS = [
    {
        name: "steinwall_status",
        description: "Cost of coding agents (Claude Code, Codex) today and this month, budget limits and how much is left. Use when the user asks what the agent costs or how much budget remains.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
        name: "steinwall_report",
        description: "SteinWall daily report: cost, estimated savings, blocked risky actions, rescued agent loops. Optional date (YYYY-MM-DD).",
        inputSchema: { type: "object", properties: { date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" } }, additionalProperties: false },
    },
    {
        name: "steinwall_scan",
        description: "Check a skill, plugin or MCP server folder for malicious patterns (prompt injection, hidden shell commands, data exfiltration, known-bad packages) before installing it. Returns OK, SUSPICIOUS or DO NOT INSTALL with findings.",
        inputSchema: { type: "object", properties: { path: { type: "string", description: "Folder or file to check" } }, required: ["path"], additionalProperties: false },
    },
];
function status(cfg) {
    const day = loadDay(localDay());
    const b = evaluateBudget(cfg, day, monthCost(day.date.slice(0, 7)));
    return JSON.stringify({ todayUsd: +b.todayUsd.toFixed(2), monthUsd: +b.monthUsd.toFixed(2), dailyBudgetUsd: cfg.budget.dailyUsd, monthlyBudgetUsd: cfg.budget.monthlyUsd, budgetStop: b.enforced, blockedToday: day.guard.denied + day.guard.asked, savedTodayUsd: +day.savings.usd.toFixed(2), note: "estimates at API list prices" });
}
export function callTool(name, args, cfg, lang) {
    if (name === "steinwall_status")
        return { text: status(cfg) };
    if (name === "steinwall_report") {
        const date = typeof args.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(args.date) ? args.date : undefined;
        return { text: buildReport(cfg, lang, date) };
    }
    if (name === "steinwall_scan") {
        if (typeof args.path !== "string" || !args.path)
            return { text: "path is required", isError: true };
        const r = scanPath(args.path);
        const label = { ok: "OK", warn: "SUSPICIOUS", block: "DO NOT INSTALL" }[r.verdict];
        return { text: `${label} (${r.files} files scanned)${r.findings.length ? `: ${summarize(r.findings, 10)}` : ""}` };
    }
    return { text: `unknown tool ${name}`, isError: true };
}
export function handle(req, cfg, lang) {
    if (req.id === undefined)
        return null; // notification
    const reply = (result) => ({ jsonrpc: "2.0", id: req.id, result });
    switch (req.method) {
        case "initialize":
            return reply({ protocolVersion: req.params?.protocolVersion ?? PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "steinwall", version: "0.1.1" } });
        case "ping":
            return reply({});
        case "tools/list":
            return reply({ tools: TOOLS });
        case "tools/call": {
            const r = callTool(req.params?.name ?? "", req.params?.arguments ?? {}, cfg, lang);
            return reply({ content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) });
        }
        default:
            return { jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } };
    }
}
export function runMcpServer() {
    const cfg = loadConfig();
    const lang = resolveLanguage(cfg);
    const rl = createInterface({ input: process.stdin });
    rl.on("line", (line) => {
        if (!line.trim())
            return;
        let req;
        try {
            req = JSON.parse(line);
        }
        catch {
            process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } })}\n`);
            return;
        }
        const res = handle(req, cfg, lang);
        if (res)
            process.stdout.write(`${JSON.stringify(res)}\n`);
    });
}
