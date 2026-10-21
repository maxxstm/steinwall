/**
 * Pro dashboard: a self-contained HTML page (no network, no scripts from elsewhere) built from the
 * local day files: cost and savings per day, savings by source, models, guard and loop counts.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { localDay } from "./fsutil.js";
import { money } from "./i18n.js";
import { steinwallHome } from "./paths.js";
import { loadDay } from "./usage.js";
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
export function collectDays(days, end = new Date()) {
    return Array.from({ length: days }, (_, i) => loadDay(localDay(new Date(end.getFullYear(), end.getMonth(), end.getDate() - (days - 1 - i)))));
}
function bars(data, lang) {
    const w = 760;
    const h = 220;
    const pad = 28;
    const max = Math.max(0.01, ...data.map((d) => d.costUsd));
    const bw = (w - pad * 2) / data.length;
    const y = (v) => h - pad - (v / max) * (h - pad * 2);
    const rects = data
        .map((d, i) => {
        const x = pad + i * bw;
        const title = `${d.date}: ${money(lang, d.costUsd)}${d.savings.usd > 0 ? ` · ${lang === "de" ? "gespart" : "saved"} ${money(lang, d.savings.usd)}` : ""}`;
        return `<g><title>${esc(title)}</title><rect x="${x + 1}" y="${y(d.costUsd)}" width="${Math.max(1, bw - 2)}" height="${h - pad - y(d.costUsd)}" class="cost"/>${d.savings.usd > 0 ? `<rect x="${x + 1}" y="${y(d.savings.usd)}" width="${Math.max(1, bw - 2)}" height="${h - pad - y(d.savings.usd)}" class="saved"/>` : ""}</g>`;
    })
        .join("");
    const first = data[0]?.date ?? "";
    const last = data[data.length - 1]?.date ?? "";
    return `<svg viewBox="0 0 ${w} ${h}" role="img" aria-label="cost per day">${rects}<line x1="${pad}" x2="${w - pad}" y1="${h - pad}" y2="${h - pad}" class="axis"/><text x="${pad}" y="${h - 8}" class="lbl">${first}</text><text x="${w - pad}" y="${h - 8}" class="lbl" text-anchor="end">${last}</text><text x="${pad}" y="16" class="lbl">${money(lang, max)}</text></svg>`;
}
export function renderDashboard(lang, data) {
    const de = lang === "de";
    const sum = (f) => data.reduce((s, d) => s + f(d), 0);
    const cost = sum((d) => d.costUsd);
    const saved = sum((d) => d.savings.usd);
    const sources = { loops: sum((d) => d.savings.bySource?.loops ?? 0), routing: sum((d) => d.savings.bySource?.routing ?? 0), trim: sum((d) => d.savings.bySource?.trim ?? 0) };
    const byModel = new Map();
    for (const d of data)
        for (const [m, v] of Object.entries(d.byModel))
            byModel.set(m, (byModel.get(m) ?? 0) + v);
    const tile = (label, value) => `<div class="tile"><div class="v">${esc(value)}</div><div class="l">${esc(label)}</div></div>`;
    const rows = [...byModel.entries()].sort((a, b) => b[1] - a[1]).map(([m, v]) => `<tr><td>${esc(m)}</td><td>≈ ${esc(money(lang, v))}</td></tr>`).join("");
    const srcLabel = de ? { loops: "Schleifen-Rettung", routing: "Modell-Routing", trim: "Ausgaben gekürzt" } : { loops: "Loop rescue", routing: "Model routing", trim: "Output trimming" };
    return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SteinWall Dashboard</title><style>
:root{--bg:#f7f6f3;--fg:#1c1b19;--muted:#6b6862;--card:#fff;--line:#e3e0da;--cost:#8d8a83;--saved:#2f7d5b}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#eeebe4;--muted:#9c988f;--card:#201f1c;--line:#34322e;--cost:#6f6c66;--saved:#4fb385}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:820px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}p.sub{color:var(--muted);margin:0 0 20px}.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px}
.tile,.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}.v{font-size:22px;font-weight:600}.l{color:var(--muted);font-size:13px}
.card{margin-bottom:16px}h2{font-size:15px;margin:0 0 10px}svg{width:100%;height:auto}.cost{fill:var(--cost)}.saved{fill:var(--saved)}.axis{stroke:var(--line)}.lbl{fill:var(--muted);font-size:11px}
table{width:100%;border-collapse:collapse}td{padding:6px 0;border-bottom:1px solid var(--line)}td:last-child{text-align:right}.legend span{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 6px 0 14px;vertical-align:middle}
footer{color:var(--muted);font-size:12px;margin-top:20px}</style></head><body><main>
<h1>SteinWall</h1><p class="sub">${de ? `Letzte ${data.length} Tage · erstellt ${new Date().toLocaleString("de-DE")}` : `Last ${data.length} days · generated ${new Date().toLocaleString("en-US")}`}</p>
<div class="tiles">${tile(de ? "Kosten (≈)" : "Cost (≈)", money(lang, cost))}${tile(de ? "Ersparnis (≈)" : "Saved (≈)", money(lang, saved))}${tile(de ? "Aktionen abgefangen" : "Actions intercepted", String(sum((d) => d.guard.denied + d.guard.asked)))}${tile(de ? "Schleifen gerettet" : "Loops rescued", String(sum((d) => d.savings.loopsRescued)))}</div>
<div class="card"><h2>${de ? "Kosten und Ersparnis pro Tag" : "Cost and savings per day"}</h2>${bars(data, lang)}<div class="legend lbl"><span style="background:var(--cost)"></span>${de ? "Kosten" : "cost"}<span style="background:var(--saved)"></span>${de ? "Ersparnis" : "saved"}</div></div>
<div class="card"><h2>${de ? "Ersparnis nach Quelle" : "Savings by source"}</h2><table>${Object.keys(sources).map((k) => `<tr><td>${srcLabel[k]}</td><td>≈ ${esc(money(lang, sources[k]))}</td></tr>`).join("")}</table></div>
<div class="card"><h2>${de ? "Modelle" : "Models"}</h2><table>${rows || `<tr><td>–</td><td></td></tr>`}</table></div>
<footer>${de ? "Alle Beträge sind Schätzungen zu API-Listenpreisen. Die Daten bleiben auf diesem Rechner." : "All amounts are estimates at API list prices. The data stays on this computer."}</footer>
</main></body></html>`;
}
export function openFile(path) {
    const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", '""', path]] : process.platform === "darwin" ? ["open", [path]] : ["xdg-open", [path]];
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}
export function writeDashboard(lang, days = 30, out = join(steinwallHome(), "dashboard.html")) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, renderDashboard(lang, collectDays(days)));
    return out;
}
