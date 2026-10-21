/**
 * Shareable savings card ("SteinWall hat mir diese Woche ≈ 47 $ gespart"). One local HTML page
 * with the card as SVG and a button that saves it as PNG (via canvas, in the browser). Nothing is
 * uploaded; sharing is the user's choice.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Language } from "./config.js";
import { money } from "./i18n.js";
import { steinwallHome } from "./paths.js";
import { collectDays } from "./dashboard.js";

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export interface CardFacts {
  savedUsd: number;
  intercepted: number;
  loops: number;
  days: number;
}

export function cardFacts(days = 7): CardFacts {
  const data = collectDays(days);
  return {
    savedUsd: data.reduce((s, d) => s + d.savings.usd, 0),
    intercepted: data.reduce((s, d) => s + d.guard.denied + d.guard.asked, 0),
    loops: data.reduce((s, d) => s + d.savings.loopsRescued, 0),
    days,
  };
}

/** Headline: savings when there are any worth showing, otherwise the protection. */
export function cardHeadline(lang: Language, f: CardFacts): string {
  const period = lang === "de" ? (f.days === 7 ? "diese Woche" : `in ${f.days} Tagen`) : f.days === 7 ? "this week" : `in ${f.days} days`;
  if (f.savedUsd >= 1) return lang === "de" ? `SteinWall hat mir ${period} ≈ ${money(lang, f.savedUsd)} gespart` : `SteinWall saved me ≈ ${money(lang, f.savedUsd)} ${period}`;
  return lang === "de" ? `SteinWall hat ${period} ${f.intercepted} riskante Aktionen abgefangen` : `SteinWall stopped ${f.intercepted} risky actions ${period}`;
}

export function renderCardSvg(lang: Language, f: CardFacts): string {
  const head = cardHeadline(lang, f);
  const sub = lang === "de" ? `${f.loops} Schleifen gerettet · ${f.intercepted} Aktionen abgefangen` : `${f.loops} loops rescued · ${f.intercepted} actions intercepted`;
  // Wrap the headline into two lines for the 1200x630 card.
  const words = head.split(" ");
  const half = Math.ceil(words.length / 2);
  const [l1, l2] = [words.slice(0, half).join(" "), words.slice(half).join(" ")];
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
<rect width="1200" height="630" fill="#1c1b19"/><rect x="40" y="40" width="1120" height="550" rx="28" fill="#24231f" stroke="#3a3833"/>
<text x="100" y="150" fill="#9c988f" font-family="system-ui,sans-serif" font-size="34" font-weight="600">SteinWall</text>
<text x="100" y="290" fill="#eeebe4" font-family="system-ui,sans-serif" font-size="64" font-weight="700">${esc(l1)}</text>
<text x="100" y="370" fill="#4fb385" font-family="system-ui,sans-serif" font-size="64" font-weight="700">${esc(l2)}</text>
<text x="100" y="450" fill="#9c988f" font-family="system-ui,sans-serif" font-size="30">${esc(sub)}</text>
<text x="100" y="535" fill="#eeebe4" font-family="system-ui,sans-serif" font-size="30" font-style="italic">Spend less. Break nothing.</text>
<text x="1100" y="535" fill="#6b6862" font-family="system-ui,sans-serif" font-size="22" text-anchor="end">${lang === "de" ? "≈ Schätzung zu API-Listenpreisen" : "≈ estimate at API list prices"}</text>
</svg>`;
}

export function writeCard(lang: Language, days = 7, out = join(steinwallHome(), "card.html")): string {
  const svg = renderCardSvg(lang, cardFacts(days));
  const button = lang === "de" ? "Als PNG speichern" : "Save as PNG";
  const html = `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><title>SteinWall card</title><style>body{margin:0;background:#111;display:flex;flex-direction:column;align-items:center;gap:16px;padding:24px;font:15px system-ui,sans-serif}svg{max-width:100%;height:auto}button{padding:10px 18px;border-radius:8px;border:0;background:#4fb385;color:#111;font-weight:600;cursor:pointer}</style></head><body>
${svg}
<button id="png">${button}</button>
<script>
document.getElementById("png").onclick = () => {
  const svg = new XMLSerializer().serializeToString(document.querySelector("svg"));
  const img = new Image();
  img.onload = () => {
    const c = document.createElement("canvas"); c.width = 1200; c.height = 630;
    c.getContext("2d").drawImage(img, 0, 0);
    const a = document.createElement("a"); a.download = "steinwall-card.png"; a.href = c.toDataURL("image/png"); a.click();
  };
  img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
};
</script></body></html>`;
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html);
  return out;
}
