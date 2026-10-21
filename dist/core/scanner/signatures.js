/**
 * Known-bad and known-vulnerable packages used by MCP servers. Bundled entries carry a source so
 * they can be checked; users and the update mechanism add entries in ~/.steinwall/signatures.json
 * (same shape), which is merged on top.
 */
import { join } from "node:path";
import { readJson } from "../fsutil.js";
import { steinwallHome } from "../paths.js";
export const BUNDLED_SIGNATURES = {
    version: "2026-10-21",
    packages: [
        {
            ecosystem: "npm",
            name: "postmark-mcp",
            versions: "*",
            kind: "malicious",
            reason: "Impostor of the official Postmark MCP server; later versions secretly BCC'd every sent e-mail to an attacker. Removed from npm.",
            source: "Koi Security disclosure, September 2025",
        },
        {
            ecosystem: "npm",
            name: "mcp-remote",
            versions: "<0.1.16",
            kind: "vulnerable",
            reason: "OS command injection when connecting to a malicious MCP server (CVE-2025-6514). Fixed in 0.1.16.",
            source: "CVE-2025-6514",
        },
    ],
};
/**
 * Well-known MCP server packages. A name one or two edits away from one of these (but not equal)
 * is a typosquatting suspect.
 */
export const WELL_KNOWN_PACKAGES = [
    "@modelcontextprotocol/server-filesystem",
    "@modelcontextprotocol/server-github",
    "@modelcontextprotocol/server-gitlab",
    "@modelcontextprotocol/server-git",
    "@modelcontextprotocol/server-postgres",
    "@modelcontextprotocol/server-sqlite",
    "@modelcontextprotocol/server-slack",
    "@modelcontextprotocol/server-memory",
    "@modelcontextprotocol/server-fetch",
    "@modelcontextprotocol/server-puppeteer",
    "@modelcontextprotocol/server-brave-search",
    "@modelcontextprotocol/server-google-maps",
    "@modelcontextprotocol/server-everything",
    "@modelcontextprotocol/server-sequential-thinking",
    "@playwright/mcp",
    "@upstash/context7-mcp",
    "@supabase/mcp-server-supabase",
    "@notionhq/notion-mcp-server",
    "@stripe/mcp",
    "@sentry/mcp-server",
    "@cloudflare/mcp-server-cloudflare",
    "mcp-remote",
    "mcp-server-git",
    "mcp-server-fetch",
    "mcp-server-time",
];
export function loadSignatures() {
    const local = readJson(join(steinwallHome(), "signatures.json"), {});
    return {
        version: local.version ?? BUNDLED_SIGNATURES.version,
        packages: [...BUNDLED_SIGNATURES.packages, ...(Array.isArray(local.packages) ? local.packages : [])],
    };
}
function compareVersions(a, b) {
    const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
    const pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d)
            return d;
    }
    return 0;
}
/** The signature matching a package (and version, if known), or null. Unknown versions match conservatively. */
export function matchPackage(list, ecosystem, name, version) {
    for (const sig of list.packages) {
        if (sig.ecosystem !== ecosystem || sig.name.toLowerCase() !== name.toLowerCase())
            continue;
        if (sig.versions === "*" || !version || !/^\d/.test(version))
            return sig;
        const below = /^<\s*(.+)$/.exec(sig.versions)?.[1];
        if (below && compareVersions(version, below) < 0)
            return sig;
    }
    return null;
}
/** Damerau-free Levenshtein distance, capped for speed. */
export function editDistance(a, b, max = 3) {
    if (Math.abs(a.length - b.length) > max)
        return max + 1;
    let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const cur = [i];
        let rowMin = i;
        for (let j = 1; j <= b.length; j++) {
            cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            rowMin = Math.min(rowMin, cur[j]);
        }
        if (rowMin > max)
            return max + 1;
        prev = cur;
    }
    return prev[b.length];
}
export function typosquatOf(name) {
    const n = name.toLowerCase();
    for (const known of WELL_KNOWN_PACKAGES) {
        if (n === known)
            return null;
        const d = editDistance(n, known, 2);
        if (d >= 1 && d <= 2 && n.length > 6)
            return known;
    }
    return null;
}
