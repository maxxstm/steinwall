// Live smoke test of the website and backend, without side effects: no mails, no cancellations, no
// charges (it opens one Checkout page, which simply expires). Run before and after every deploy:
//   npm run smoke
//   SMOKE_SITE=https://staging.example SMOKE_API=https://api.staging.example npm run smoke
const SITE = (process.env.SMOKE_SITE || "https://steinwall.dev").replace(/\/$/, "");
const API = (process.env.SMOKE_API || "https://api.steinwall.dev").replace(/\/$/, "");

const results = [];
async function check(name, fn) {
  try {
    const note = await fn();
    results.push({ ok: true, name, note: note || "" });
  } catch (err) {
    results.push({ ok: false, name, note: err instanceof Error ? err.message : String(err) });
  }
}
function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}
const get = (url, init) => fetch(url, { signal: AbortSignal.timeout(15_000), ...init });
const post = (path, body) => get(`${API}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: SITE }, body: JSON.stringify(body) });

const PAGES = ["/", "/license.html", "/manage.html", "/kuendigen.html", "/impressum.html", "/datenschutz.html", "/agb.html", "/widerruf.html", "/llms.txt"];
for (const page of PAGES) {
  await check(`site ${page}`, async () => {
    const res = await get(`${SITE}${page}`);
    expect(res.status === 200, `HTTP ${res.status}`);
    if (page.endsWith(".html") || page === "/") {
      const html = await res.text();
      // The cancel button (§ 312k BGB) must be reachable from every page.
      expect(/href="[^"]*kuendigen\.html"/.test(html), "no link to kuendigen.html (cancel button)");
    }
  });
}

await check("site config.js points at the API", async () => {
  const js = await (await get(`${SITE}/config.js`)).text();
  expect(js.includes(API), `apiUrl is not ${API}`);
});

await check("search engines", async () => {
  const tag = (await get(`${SITE}/`)).headers.get("x-robots-tag");
  return tag?.includes("noindex") ? "hidden (noindex) – remove site/_headers at launch" : "indexable";
});

await check("api /health", async () => {
  const body = await (await get(`${API}/health`)).json();
  expect(body.ok === true, `problems: ${body.problems?.join("; ")}`);
});

await check("api CORS for the website", async () => {
  const res = await get(`${API}/telemetry`, { headers: { origin: SITE } });
  expect(res.status === 200, `HTTP ${res.status}`);
  const allowed = res.headers.get("access-control-allow-origin");
  expect(allowed === SITE || allowed === "*", `allow-origin is ${allowed}`);
});

await check("api /checkout opens Stripe Checkout", async () => {
  const res = await post("/checkout", { plan: "monthly" });
  const body = await res.json();
  expect(res.status === 200 && /^https:\/\/checkout\.stripe\.com\//.test(body.url ?? ""), `HTTP ${res.status} ${JSON.stringify(body).slice(0, 120)}`);
  return body.url.includes("cs_test_") ? "test mode" : "LIVE mode";
});

await check("api rejects bad input (no side effects)", async () => {
  expect((await get(`${API}/license?session_id=nope`)).status === 400, "/license accepted a bad session id");
  expect((await post("/license/resend", { email: "not-an-email" })).status === 400, "/license/resend accepted a bad email");
  expect((await post("/portal", { token: "SW1.forged.sig" })).status === 400, "/portal accepted a forged key");
  expect((await post("/cancel", { email: "not-an-email" })).status === 400, "/cancel accepted a bad email");
  expect((await get(`${API}/nope`)).status === 404, "unknown route is not 404");
});

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.note ? `  – ${r.note}` : ""}`);
}
console.log(`\n${results.length - failed}/${results.length} passed (${SITE}, ${API})`);
process.exitCode = failed ? 1 : 0;
