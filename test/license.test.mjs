// Licensing end to end: tokens signed by the backend code verify in the plugin; trial, grace,
// refresh; Stripe webhook signatures.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STEINWALL_HOME = mkdtempSync(join(tmpdir(), "sw-license-"));
const backend = await import("../backend/worker/src/license.ts");
const { verifyStripeSignature, formEncode } = await import("../backend/worker/src/stripe.ts");
const lic = await import("../dist/core/license.js");

const DAY = 86_400_000;
const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
const spki = Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64");
const priv = await backend.importPrivateKey(jwk);

const token = (exp, extra = {}) =>
  backend.signLicense({ v: 1, lid: "lic_1", plan: "pro", exp: new Date(exp).toISOString(), iat: new Date().toISOString(), ref: "SW-ABCDEFGH", ...extra }, priv);

test("backend-signed tokens verify in the plugin; tampering fails", async () => {
  const t = await token(Date.now() + 30 * DAY, { founder: true });
  const payload = lic.verifyToken(t, spki);
  assert.equal(payload.lid, "lic_1");
  assert.equal(payload.founder, true);
  const [h, body, sig] = t.split(".");
  const forged = Buffer.from(JSON.stringify({ ...payload, exp: "2099-01-01T00:00:00.000Z" })).toString("base64url");
  assert.equal(lic.verifyToken(`${h}.${forged}.${sig}`, spki), null);
  assert.equal(lic.verifyToken(t, ""), null, "no public key built in: nothing validates");
  assert.ok(await backend.verifyLicense(t, await backend.publicKeyFromPrivate(jwk)), "backend verifies its own tokens (refresh)");
  assert.equal(body.length > 0, true);
});

test("trial: 5 days from first start, then off", () => {
  const start = Date.now();
  assert.deepEqual([lic.proStatus(start, spki).reason, lic.proStatus(start, spki).trialDaysLeft], ["trial", 5]);
  assert.equal(lic.proStatus(start + 4.5 * DAY, spki).reason, "trial");
  assert.equal(lic.proStatus(start + 5.1 * DAY, spki).pro, false);
});

test("license: active, grace after expiry, then off; activation checks the signature", async () => {
  const now = Date.now() + 10 * DAY; // trial is over
  assert.throws(() => lic.activateLicense("SW1.bad.sig", spki), /invalid license key/);
  lic.activateLicense(await token(now + 3 * DAY), spki);
  assert.deepEqual([lic.proStatus(now, spki).reason, lic.proStatus(now, spki).licenseDaysLeft], ["license", 3]);
  assert.equal(lic.proStatus(now + 6 * DAY, spki).reason, "grace");
  assert.equal(lic.proStatus(now + 11 * DAY, spki).pro, false);
});

test("refresh: new token stored, 410 revokes, network errors keep the token", async () => {
  const fresh = await token(Date.now() + 60 * DAY);
  const ok = async () => new Response(JSON.stringify({ token: fresh }), { status: 200 });
  assert.equal(await lic.refreshLicense("https://api.example", ok, spki), "updated");
  assert.equal(lic.proStatus(Date.now() + 20 * DAY, spki).reason, "license");
  assert.equal(await lic.refreshLicense("https://api.example", async () => { throw new Error("offline"); }, spki), "offline");
  assert.equal(lic.proStatus(Date.now() + 20 * DAY, spki).reason, "license");
  assert.equal(await lic.refreshLicense("https://api.example", async () => new Response("{}", { status: 410 }), spki), "revoked");
  assert.equal(lic.proStatus(Date.now() + 20 * DAY, spki).pro, false);
});

test("manage: the portal link is requested with the stored key only", async () => {
  lic.activateLicense(await token(Date.now() + 30 * DAY), spki);
  let sent;
  const url = await lic.portalUrl("https://api.example/", async (u, init) => {
    sent = { u, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ url: "https://billing.stripe.test/p/1" }), { status: 200 });
  });
  assert.equal(url, "https://billing.stripe.test/p/1");
  assert.equal(sent.u, "https://api.example/portal");
  assert.deepEqual(Object.keys(sent.body), ["token"]);
  await assert.rejects(lic.portalUrl("https://api.example", async () => new Response(JSON.stringify({ error: "unknown license" }), { status: 404 })), /unknown license/);
  lic.deactivateLicense();
  await assert.rejects(lic.portalUrl("https://api.example", async () => new Response("{}")), /no license activated/);
});

test("Stripe webhook signature: valid, wrong secret, replayed", async () => {
  const body = JSON.stringify({ type: "checkout.session.completed" });
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", "whsec_test").update(`${t}.${body}`).digest("hex");
  assert.equal(await verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_test"), true);
  assert.equal(await verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_other"), false);
  assert.equal(await verifyStripeSignature(body, `t=${t - 3600},v1=${sig}`, "whsec_test"), false);
  assert.equal(await verifyStripeSignature(body + " ", `t=${t},v1=${sig}`, "whsec_test"), false);
});

test("Stripe form encoding handles nested line items", () => {
  assert.deepEqual(formEncode({ mode: "subscription", line_items: [{ price: "price_1", quantity: 1 }], metadata: { plan: "founder" } }), [
    "mode=subscription",
    "line_items%5B0%5D%5Bprice%5D=price_1",
    "line_items%5B0%5D%5Bquantity%5D=1",
    "metadata%5Bplan%5D=founder",
  ]);
});

test("referral codes and expiry with bonus days", () => {
  assert.match(backend.newReferralCode(), /^SW-[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(backend.licenseExpiry(new Date("2026-01-01T00:00:00Z"), 30).toISOString(), "2026-01-31T00:00:00.000Z");
});
