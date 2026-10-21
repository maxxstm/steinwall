// Backend Worker end to end against the real D1 schema (Node's SQLite stands in for D1) with Stripe mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const { handle } = await import("../backend/worker/src/index.ts");
const { verifyLicense } = await import("../backend/worker/src/license.ts");

const DAY = 86_400_000;
const WEBHOOK_SECRET = "whsec_test_worker";

/** The subset of the D1 binding the Worker uses, backed by an in-memory SQLite database. */
function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec("pragma foreign_keys = on");
  db.exec(readFileSync(new URL("../backend/worker/schema.sql", import.meta.url), "utf8"));
  const statement = (sql, params = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => db.prepare(sql).get(...params) ?? null,
    run: async () => ({ results: [], meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
  });
  return { prepare: (sql) => statement(sql), batch: async (list) => Promise.all(list.map((s) => s.run())), sqlite: db };
}

const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));

function makeEnv() {
  return {
    DB: fakeD1(),
    SITE_URL: "https://example.test/",
    STRIPE_PRICE_MONTHLY: "price_m",
    STRIPE_PRICE_YEARLY: "price_y",
    STRIPE_PRICE_FOUNDER: "price_f",
    STRIPE_SECRET_KEY: "sk_test_worker",
    STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    LICENSE_PRIVATE_JWK: jwk,
  };
}

/** Stripe API mock: subscriptions report a period end in 30 days (on the item, like newer API versions). */
const stripeCalls = [];
globalThis.fetch = async (url, init = {}) => {
  stripeCalls.push({ url: String(url), body: init.body });
  if (String(url).includes("/subscriptions/")) {
    const id = String(url).split("/subscriptions/")[1];
    return Response.json({ id, status: "active", customer: "cus_x", items: { data: [{ current_period_end: Math.floor((Date.now() + 30 * DAY) / 1000) }] } });
  }
  if (String(url).endsWith("/checkout/sessions")) return Response.json({ url: "https://checkout.stripe.test/c/pay/cs_test_1" });
  return Response.json({ error: { message: "unexpected" } }, { status: 500 });
};

const req = (path, init) => new Request(`https://api.test${path}`, init);
const post = (path, body) => req(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function webhook(event, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${raw}`).digest("hex");
  return req("/stripe-webhook", { method: "POST", headers: { "stripe-signature": `t=${t},v1=${sig}` }, body: raw });
}

const completed = (session, customer, ref) => ({
  type: "checkout.session.completed",
  data: { object: { id: session, subscription: `sub_${session}`, customer, client_reference_id: ref, customer_details: { email: "a@example.test" }, metadata: { plan: "monthly" } } },
});

test("checkout creates a Stripe session with the plan's price and the site's return urls", async () => {
  const env = makeEnv();
  stripeCalls.length = 0;
  const res = await handle(post("/checkout", { plan: "yearly", ref: "SW-ABCDEFGH" }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, "https://checkout.stripe.test/c/pay/cs_test_1");
  const body = decodeURIComponent(stripeCalls[0].body);
  assert.match(body, /line_items\[0\]\[price\]=price_y/);
  assert.match(body, /success_url=https:\/\/example\.test\/license\.html\?session_id=\{CHECKOUT_SESSION_ID\}/);
  assert.match(body, /client_reference_id=SW-ABCDEFGH/);
  assert.equal((await handle(post("/checkout", { plan: "lifetime" }), env)).status, 400);
});

test("checkout refuses the founder price once 500 founder licenses exist", async () => {
  const env = makeEnv();
  const insert = env.DB.sqlite.prepare("insert into licenses (id, plan, founder, referral_code, period_end) values (?, 'founder', 1, ?, '2030-01-01T00:00:00Z')");
  for (let i = 0; i < 500; i++) insert.run(`l${i}`, `SW-F${i}`);
  assert.equal((await handle(post("/checkout", { plan: "founder" }), env)).status, 409);
});

test("webhook rejects a bad signature", async () => {
  const res = await handle(webhook(completed("cs_bad", "cus_a"), "whsec_wrong"), makeEnv());
  assert.equal(res.status, 400);
});

test("purchase -> license on the success page, once per session, verifiable offline", async () => {
  const env = makeEnv();
  assert.equal((await handle(req("/license?session_id=cs_1"), env)).status, 202, "pending before the webhook");
  assert.equal((await handle(webhook(completed("cs_1", "cus_a")), env)).status, 200);
  assert.equal((await handle(webhook(completed("cs_1", "cus_a")), env)).status, 200, "duplicate delivery is fine");
  assert.equal(env.DB.sqlite.prepare("select count(*) as n from licenses").get().n, 1);

  const res = await handle(req("/license?session_id=cs_1"), env);
  assert.equal(res.status, 200);
  const { token, referralCode } = await res.json();
  assert.match(referralCode, /^SW-[A-Z2-9]{8}$/);
  const payload = await verifyLicense(token, pair.publicKey);
  assert.equal(payload.plan, "pro");
  assert.equal(payload.founder, false);
  assert.ok(new Date(payload.exp).getTime() > Date.now() + 29 * DAY);
  assert.equal((await handle(req("/license?session_id=nope"), env)).status, 400);
});

test("referral credits the referrer 30 days, but not a self-referral", async () => {
  const env = makeEnv();
  await handle(webhook(completed("cs_r", "cus_ref")), env);
  const code = env.DB.sqlite.prepare("select referral_code from licenses where checkout_session = 'cs_r'").get().referral_code;
  await handle(webhook(completed("cs_self", "cus_ref", code)), env);
  assert.equal(env.DB.sqlite.prepare("select bonus_days from licenses where checkout_session = 'cs_r'").get().bonus_days, 0);
  await handle(webhook(completed("cs_new", "cus_new", code)), env);
  await handle(webhook(completed("cs_new", "cus_new", code)), env);
  assert.equal(env.DB.sqlite.prepare("select bonus_days from licenses where checkout_session = 'cs_r'").get().bonus_days, 30);
  assert.equal(env.DB.sqlite.prepare("select count(*) as n from referrals").get().n, 1);
});

test("refresh renews an active license and ends a canceled one after the grace period", async () => {
  const env = makeEnv();
  await handle(webhook(completed("cs_f", "cus_f")), env);
  const { token } = await (await handle(req("/license?session_id=cs_f"), env)).json();
  const fresh = await handle(post("/license-refresh", { token }), env);
  assert.equal(fresh.status, 200);
  assert.ok(await verifyLicense((await fresh.json()).token, pair.publicKey));

  const ended = Math.floor((Date.now() - 10 * DAY) / 1000);
  await handle(webhook({ type: "customer.subscription.deleted", data: { object: { id: "sub_cs_f", status: "canceled", customer: "cus_f", items: { data: [{ current_period_end: ended }] } } } }), env);
  assert.equal(env.DB.sqlite.prepare("select status from licenses where checkout_session = 'cs_f'").get().status, "canceled");
  assert.equal((await handle(post("/license-refresh", { token }), env)).status, 410);
  assert.equal((await handle(post("/license-refresh", { token: "SW1.forged.sig" }), env)).status, 400);
});

test("telemetry stores one number per install and day and sums them for the counter", async () => {
  const env = makeEnv();
  const day = new Date().toISOString().slice(0, 10);
  const id = "1b4e28ba-2fa1-41d2-883f-0016d3cca427";
  assert.equal((await handle(post("/telemetry", { installId: id, day, savedUsd: 1.234 }), env)).status, 200);
  assert.equal((await handle(post("/telemetry", { installId: id, day, savedUsd: 2.5 }), env)).status, 200, "same day overwrites");
  assert.equal((await handle(post("/telemetry", { installId: "2b4e28ba-2fa1-41d2-883f-0016d3cca427", day, savedUsd: 1 }), env)).status, 200);
  assert.equal((await handle(post("/telemetry", { installId: id, day, savedUsd: 5000 }), env)).status, 400);
  assert.equal((await handle(post("/telemetry", { installId: "x", day, savedUsd: 1 }), env)).status, 400);
  assert.deepEqual(await (await handle(req("/telemetry"), env)).json(), { totalUsd: 3.5, installs: 2 });
});

test("routing, CORS and errors", async () => {
  const env = makeEnv();
  assert.equal((await handle(req("/nope"), env)).status, 404);
  const pre = await handle(req("/checkout", { method: "OPTIONS" }), env);
  assert.equal(pre.headers.get("access-control-allow-origin"), "*");
  const res = await handle(post("/checkout", { plan: "monthly" }), { ...env, STRIPE_SECRET_KEY: "" });
  assert.equal(res.status, 500, "a missing secret is a 500, not a crash");
  assert.equal((await handle(req("/telemetry"), { ...env, SITE_ORIGIN: "https://steinwall.example" })).headers.get("access-control-allow-origin"), "https://steinwall.example");
});
