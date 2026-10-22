// Backend Worker end to end against the real D1 schema (Node's SQLite stands in for D1) with Stripe mocked.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const { handle, selfCheck } = await import("../backend/worker/src/index.ts");
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
    all: async () => ({ results: db.prepare(sql).all(...params), meta: { changes: 0 } }),
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
    RESEND_API_KEY: "re_test_worker",
    OWNER_EMAIL: "owner@example.test",
  };
}

/**
 * Stripe and Resend mock: subscriptions report a period end in 30 days (on the item, like newer API
 * versions); sent mails are collected in `mails`.
 */
const stripeCalls = [];
const mails = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url) === "https://api.resend.com/emails") {
    mails.push(JSON.parse(init.body));
    return Response.json({ id: "mail_1" });
  }
  stripeCalls.push({ url: String(url), method: init.method, body: init.body });
  if (String(url).endsWith("/billing_portal/sessions")) return Response.json({ url: "https://billing.stripe.test/p/session_1" });
  if (String(url).includes("/prices/")) return Response.json({ id: String(url).split("/prices/")[1], active: !String(url).endsWith("price_inactive") });
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
  data: { object: { id: session, subscription: `sub_${session}`, customer, client_reference_id: ref, customer_details: { email: "a@example.test", address: { country: "DE" } }, metadata: { plan: "monthly" } } },
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
  assert.ok(body.includes("consent_collection[terms_of_service]=required"), "the consent checkbox is required");
  assert.ok(body.includes("I expressly request that SteinWall Pro starts immediately") && body.includes("Widerrufsrecht"), "withdrawal waiver in both languages");
  assert.equal((await handle(post("/checkout", { plan: "lifetime" }), env)).status, 400);
  assert.doesNotMatch(body, /automatic_tax/, "no tax settings until Stripe Tax is set up");
  stripeCalls.length = 0;
  await handle(post("/checkout", { plan: "monthly" }), { ...env, STRIPE_TAX: "on" });
  const taxed = decodeURIComponent(stripeCalls[0].body);
  assert.ok(taxed.includes("automatic_tax[enabled]=true"));
  assert.ok(taxed.includes("tax_id_collection[enabled]=true"));
  assert.match(taxed, /billing_address_collection=auto/);
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

test("setup check names swapped or broken secrets without revealing them", async () => {
  const env = makeEnv();
  assert.deepEqual(await (await handle(req("/health"), env)).json(), { ok: true, problems: [] });
  const swapped = { ...env, STRIPE_SECRET_KEY: "whsec_abc123", STRIPE_WEBHOOK_SECRET: "sk_test_abc123", LICENSE_PRIVATE_JWK: "{\"kty\":" };
  const { ok, problems } = await (await handle(req("/health"), swapped)).json();
  assert.equal(ok, false);
  assert.match(problems[0], /STRIPE_SECRET_KEY must start with sk_ or rk_, but starts with whsec_ \(this is the webhook signing secret\)/);
  assert.match(problems[1], /STRIPE_WEBHOOK_SECRET must start with whsec_, but starts with sk_ \(this is the Stripe secret key\)/);
  assert.match(problems[2], /LICENSE_PRIVATE_JWK is not valid JSON/);
  assert.ok(!JSON.stringify(problems).includes("abc123"), "values never appear");
  assert.match((await handle(req("/health"), { ...env, STRIPE_SECRET_KEY: "pk_test_x" })).headers.get("content-type"), /json/);
  assert.deepEqual((await (await handle(req("/health"), { ...env, STRIPE_PRICE_YEARLY: "" })).json()).problems, ["STRIPE_PRICE_YEARLY is not set"]);
  const res = await handle(post("/checkout", { plan: "monthly" }), swapped);
  assert.equal(res.status, 500, "checkout refuses to call Stripe with a swapped key");
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

test("the license key is emailed once per purchase, in the buyer's language", async () => {
  const env = makeEnv();
  mails.length = 0;
  await handle(webhook(completed("cs_mail", "cus_mail")), env);
  await handle(webhook(completed("cs_mail", "cus_mail")), env);
  assert.equal(mails.length, 1, "a duplicate webhook sends no second mail");
  const m = mails[0];
  assert.deepEqual(m.to, ["a@example.test"]);
  assert.equal(m.from, "SteinWall <license@steinwall.dev>");
  assert.match(m.subject, /Lizenzschlüssel/);
  const token = /license activate (SW1\.\S+)/.exec(m.text)[1];
  assert.ok(await verifyLicense(token, pair.publicKey), "the mailed key is valid");
  assert.match(m.text, /kuendigen\.html/);
  assert.match(m.text, /Widerrufsrecht mit diesem Beginn erloschen/, "consent confirmed on a durable medium");
  assert.ok(env.DB.sqlite.prepare("select key_emailed_at from licenses where checkout_session = 'cs_mail'").get().key_emailed_at);
});

test("a failing mail service does not fail the webhook", async () => {
  const env = makeEnv();
  const res = await handle(webhook(completed("cs_nomail", "cus_nomail")), { ...env, RESEND_API_KEY: "" });
  assert.equal(res.status, 200);
  assert.equal(env.DB.sqlite.prepare("select count(*) as n from licenses where checkout_session = 'cs_nomail'").get().n, 1);
});

test("lost key: neutral answer, keys only to known addresses, at most every 10 minutes", async () => {
  const env = makeEnv();
  await handle(webhook(completed("cs_lost", "cus_lost")), env);
  mails.length = 0;
  const first = await handle(post("/license/resend", { email: "A@Example.test" }), env);
  const unknown = await handle(post("/license/resend", { email: "nobody@example.test" }), env);
  assert.deepEqual(await first.json(), await unknown.json(), "the answer does not reveal whether the address has a license");
  assert.equal(mails.length, 1);
  assert.match(mails[0].text, /license activate SW1\./);
  await handle(post("/license/resend", { email: "a@example.test" }), env);
  assert.equal(mails.length, 1, "rate limited");
  assert.equal((await handle(post("/license/resend", { email: "not-an-email" }), env)).status, 400);
});

test("portal: a valid key opens the Stripe customer portal, a forged one does not", async () => {
  const env = makeEnv();
  await handle(webhook(completed("cs_portal", "cus_portal")), env);
  const { token } = await (await handle(req("/license?session_id=cs_portal"), env)).json();
  stripeCalls.length = 0;
  const res = await handle(post("/portal", { token }), env);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, "https://billing.stripe.test/p/session_1");
  assert.match(decodeURIComponent(stripeCalls[0].body), /customer=cus_portal&return_url=https:\/\/example\.test/);
  assert.equal((await handle(post("/portal", { token: "SW1.forged.sig" }), env)).status, 400);
});

test("cancel button: ends the subscription at period end and confirms by email", async () => {
  const env = makeEnv();
  await handle(webhook(completed("cs_cancel", "cus_cancel")), env);
  mails.length = 0;
  stripeCalls.length = 0;
  const res = await handle(post("/cancel", { email: "a@example.test", kind: "ordinary" }), env);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.contracts.length, 1);
  assert.equal(stripeCalls[0].method, "POST");
  assert.match(stripeCalls[0].url, /\/subscriptions\/sub_cs_cancel$/);
  assert.equal(stripeCalls[0].body, "cancel_at_period_end=true");
  assert.equal(mails.length, 1, "an ordinary, matched cancellation needs no owner notice");
  assert.match(mails[0].subject, /Kündigung/);
  assert.match(mails[0].text, /Eingang: .*\(Europe\/Berlin\)/);
  assert.match(mails[0].text, /endet zum/);
  assert.equal(env.DB.sqlite.prepare("select matched from cancellations").get().matched, 1);
});

test("cancel button without a matching subscription: receipt confirmed, owner notified, no mail flood", async () => {
  const env = makeEnv();
  mails.length = 0;
  const res = await handle(post("/cancel", { email: "stranger@example.test", kind: "extraordinary", reason: "moving" }), env);
  assert.equal((await res.json()).contracts.length, 0);
  assert.deepEqual(mails.map((m) => m.to[0]), ["stranger@example.test", "owner@example.test"]);
  assert.match(mails[0].text, /no active subscription|kein aktives Abo/);
  assert.match(mails[1].subject, /without matching subscription/);
  await handle(post("/cancel", { email: "stranger@example.test" }), env);
  assert.equal(mails.filter((m) => m.to[0] === "stranger@example.test").length, 1, "no second confirmation within 10 minutes");
  assert.equal(env.DB.sqlite.prepare("select count(*) as n from cancellations").get().n, 2, "every declaration is still logged");
});

test("health names a wrong mail key", async () => {
  const env = makeEnv();
  const { problems } = await (await handle(req("/health"), { ...env, RESEND_API_KEY: "sk_test_x" })).json();
  assert.deepEqual(problems, ["RESEND_API_KEY must start with re_, but starts with sk_"]);
});

test("daily self-check: silent when healthy, mails the owner about errors and broken prices", async () => {
  const env = makeEnv();
  mails.length = 0;
  assert.deepEqual(await selfCheck(env), []);
  assert.equal(mails.length, 0, "no mail when all is well");

  const res = await handle(post("/checkout", { plan: "monthly" }), { ...env, STRIPE_SECRET_KEY: "" });
  assert.equal(res.status, 500);
  assert.equal(env.DB.sqlite.prepare("select count(*) as n from errors").get().n, 1, "the error is kept for the self-check");

  const problems = await selfCheck({ ...env, STRIPE_PRICE_YEARLY: "price_inactive" });
  assert.equal(problems.length, 2);
  assert.match(problems[0], /price for yearly is inactive/);
  assert.match(problems[1], /1 error\(s\) in the last 24 hours:\n.*\/checkout: missing secret STRIPE_SECRET_KEY/);
  assert.equal(mails.length, 1);
  assert.deepEqual(mails[0].to, ["owner@example.test"]);
  assert.match(mails[0].subject, /Daily self-check found problems/);

  await selfCheck(env, Date.now() + 31 * 86_400_000);
  assert.equal(env.DB.sqlite.prepare("select count(*) as n from errors").get().n, 0, "errors older than 30 days are pruned");
});

test("malformed license keys are rejected as invalid, never as a server error", async () => {
  const env = makeEnv();
  for (const token of ["SW1.forged.sig", "SW1.e30.%%%", "SW1..", "SW1.e30.AAAA"]) {
    assert.equal((await handle(post("/portal", { token }), env)).status, 400, token);
    assert.equal((await handle(post("/license-refresh", { token }), env)).status, 400, token);
  }
  const res = await handle(post("/cancel", { email: "x@example.test", key: "SW1.garbage.%%" }), env);
  assert.equal(res.status, 200, "a mistyped key does not break the cancellation");
});
