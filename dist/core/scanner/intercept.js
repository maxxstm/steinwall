/**
 * Scan an extension before the agent installs it: `claude mcp add`, `claude plugin install` from a
 * local marketplace, `claude plugin marketplace add <dir>`, and file writes into skill, command,
 * agent, plugin or MCP config locations. Remote sources that cannot be read before installation
 * are reported as unscannable; the inventory check catches them right after.
 */
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { readJson } from "../fsutil.js";
import { claudeConfigDir } from "../paths.js";
import { commandName, effectiveArgs, parseShell } from "../guard/shell.js";
import { parsePatch, patchText } from "../guard/patch.js";
import { contextFor, scanMcpConfig, scanMcpServer, scanPath, scanText, sortFindings, verdictOf } from "./index.js";
const EXTENSION_PATH = /\/\.claude\/(skills|commands|agents)\/|\/\.claude-plugin\/|\/\.codex\/(skills|prompts|plugins)\/|\/\.agents\/(skills|plugins)\/|\/\.codex-plugin\/|\/\.codex\/config\.toml$|\/hooks\/[\w-]*hooks\.json$|\/\.?mcp\.json$|\/\.claude\.json$|\/skill\.md$/;
export function isExtensionPath(path) {
    return EXTENSION_PATH.test(`/${path.replace(/\\/g, "/").toLowerCase()}`);
}
function result(target, findings, files = 1) {
    const sorted = sortFindings(findings);
    return { target, findings: sorted, verdict: verdictOf(sorted), files, skipped: 0 };
}
function checkFileWrite(tool, input) {
    const path = [input.file_path, input.notebook_path].find((v) => typeof v === "string");
    if (!path || !isExtensionPath(path))
        return null;
    let text = "";
    if (typeof input.content === "string")
        text = input.content;
    else if (typeof input.new_string === "string")
        text = input.new_string;
    else if (Array.isArray(input.edits))
        text = input.edits.map((e) => e.new_string ?? "").join("\n");
    if (!text)
        return null;
    const name = basename(path).toLowerCase();
    const findings = scanText(text, path, contextFor(path) ?? "instructions");
    if ((name === ".mcp.json" || name === ".claude.json") && tool.toLowerCase() === "write") {
        try {
            findings.push(...scanMcpConfig(JSON.parse(text), path));
        }
        catch {
            // partial JSON: the text rules still apply
        }
    }
    return { target: path, result: result(path, findings) };
}
const MCP_FLAGS_WITH_VALUE = new Set(["-s", "--scope", "-t", "--transport", "-e", "--env", "-H", "--header", "--client-id", "--callback-port"]);
/** `claude mcp add [flags] <name> <command|url> [args...]`, `--` separates the server command. */
function parseMcpAdd(rest) {
    const positional = [];
    for (let i = 0; i < rest.length; i++) {
        const t = rest[i];
        if (t === "--") {
            positional.push(...rest.slice(i + 1));
            break;
        }
        if (t.startsWith("-") && positional.length < 2) {
            if (MCP_FLAGS_WITH_VALUE.has(t))
                i++;
            continue;
        }
        positional.push(t);
    }
    const [name, target, ...args] = positional;
    if (!name || !target)
        return null;
    return { name, entry: /^https?:\/\//i.test(target) ? { url: target } : { command: target, args } };
}
/** Find a plugin's source folder in an already added marketplace; null when it is remote. */
export function resolvePluginSource(spec) {
    const [plugin, market] = spec.split("@");
    const known = readJson(join(claudeConfigDir(), "plugins", "known_marketplaces.json"), {});
    for (const [name, m] of Object.entries(known)) {
        if (market && name !== market)
            continue;
        if (!m.installLocation)
            continue;
        const manifest = readJson(join(m.installLocation, ".claude-plugin", "marketplace.json"), {});
        const entry = manifest.plugins?.find((p) => p.name === plugin);
        if (!entry)
            continue;
        if (typeof entry.source === "string")
            return resolve(m.installLocation, entry.source);
        return null;
    }
    return null;
}
function checkCommand(command, cwd) {
    for (const seg of parseShell(command)) {
        const args = effectiveArgs(seg.tokens);
        const name = commandName(args[0] ?? "");
        if (name === "claude") {
            const [, area, action, ...rest] = args;
            if (area === "mcp" && action === "add") {
                const parsed = parseMcpAdd(rest);
                if (parsed)
                    return { target: `MCP server "${parsed.name}"`, result: result(parsed.name, scanMcpServer(parsed.name, parsed.entry, "claude mcp add")) };
            }
            if (area === "mcp" && action === "add-json") {
                const positional = rest.filter((a) => !a.startsWith("-"));
                try {
                    const entry = JSON.parse(positional[1] ?? "");
                    return { target: `MCP server "${positional[0]}"`, result: result(positional[0] ?? "mcp", scanMcpServer(positional[0] ?? "mcp", entry, "claude mcp add-json")) };
                }
                catch {
                    return null;
                }
            }
            if ((area === "plugin" || area === "plugins") && (action === "install" || action === "i")) {
                const spec = rest.find((a) => !a.startsWith("-"));
                if (!spec)
                    return null;
                const dir = resolvePluginSource(spec);
                return dir && existsSync(dir) ? { target: `plugin ${spec}`, result: scanPath(dir) } : { target: `plugin ${spec}`, unscannable: "remote source" };
            }
            if ((area === "plugin" || area === "plugins") && action === "marketplace" && rest[0] === "add") {
                const src = rest.slice(1).find((a) => !a.startsWith("-"));
                if (!src)
                    return null;
                const local = isAbsolute(src) ? src : resolve(cwd ?? ".", src);
                if (existsSync(local) && statSync(local).isDirectory())
                    return { target: `marketplace ${src}`, result: scanPath(local) };
                return { target: `marketplace ${src}`, unscannable: "remote source" };
            }
        }
        // Cloning straight into a skills/commands/agents folder.
        if (name === "git" && args[1] === "clone" && args.slice(2).some((a) => isExtensionPath(`${a}/`))) {
            return { target: args.slice(2).find((a) => !a.startsWith("-")) ?? "repository", unscannable: "remote source" };
        }
    }
    return null;
}
/** Codex apply_patch: scan the added lines of every file it adds or changes in an extension location. */
function checkPatch(input) {
    const text = patchText(input);
    if (!text)
        return null;
    const files = parsePatch(text).filter((f) => f.op !== "delete" && isExtensionPath(f.moveTo ?? f.path) && f.added);
    if (!files.length)
        return null;
    const findings = files.flatMap((f) => {
        const path = f.moveTo ?? f.path;
        const found = scanText(f.added, path, contextFor(path) ?? "instructions");
        const name = basename(path).toLowerCase();
        if ((name === ".mcp.json" || name === ".claude.json") && f.op === "add") {
            try {
                found.push(...scanMcpConfig(JSON.parse(f.added), path));
            }
            catch {
                // partial JSON
            }
        }
        return found;
    });
    const target = files.map((f) => f.moveTo ?? f.path).join(", ");
    return { target, result: result(target, findings, files.length) };
}
export function checkInstall(tool, input, cwd) {
    const t = tool.toLowerCase();
    if (t === "apply_patch")
        return checkPatch(input);
    if (t === "write" || t === "edit" || t === "multiedit")
        return checkFileWrite(tool, input);
    if ((t === "bash" || t === "powershell") && typeof input.command === "string")
        return checkCommand(input.command, cwd);
    return null;
}
