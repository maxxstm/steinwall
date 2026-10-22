// SteinWall backend as one Cloudflare Worker with a D1 database. Routes:
//   POST /checkout         { plan, ref? } -> { url } of a Stripe Checkout page
//   POST /stripe-webhook   creates licenses on purchase, keeps period and status in sync, credits referrals
//   GET  /license          ?session_id=cs_... -> { token, referralCode } for the success page
//   POST /license-refresh  { token } -> { token } with the current period, or 410 when the license has ended
//   GET  /telemetry        -> { totalUsd, installs } for the public counter
//   POST /telemetry        { installId, day, savedUsd } opt-in, one number per install and day
//   GET  /health           { ok, problems } setup check: missing or swapped secrets, never their values
//   POST /license/resend   { email } -> neutral answer; emails the keys of that address (at most every 10 minutes)
//   POST /portal           { token } -> { url } of the Stripe customer portal (payment method, invoices)
//   POST /cancel           { email, kind, reason?, key? } cancel button (§ 312k BGB): ends subscriptions at
//                          period end and confirms in text form by email
import { cancellationMail, type CancelledContract, type Lang, langFor, licenseMail, ownerMail, resendMail, sendEmail } from "./email.ts";
import { importPrivateKey, licenseExpiry, type LicensePayload, newReferralCode, publicKeyFromPrivate, signLicense, verifyLicense } from "./license.ts";
import { stripe, verifyStripeSignature } from "./stripe.ts";

/** The part of Cloudflare's D1 binding this Worker uses. */
export interface D1Result<T = Record<string, unknown>> {
  results: T[];
  meta: { changes: number };
}
export interface D1PreparedStatement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<D1Result>;
  all<T = Record<string, unknown>>(): Promise<D1Result<T>>;
}
export interface D1Database {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: D1PreparedStatement[]): Promise<D1Result[]>;
}

export interface Env {
  DB: D1Database;
  SITE_URL: string;
  /** Allowed browser origin for the website; "*" while there is no own domain. */
  SITE_ORIGIN?: string;
  STRIPE_PRICE_MONTHLY: string;
  STRIPE_PRICE_YEARLY: string;
  STRIPE_PRICE_FOUNDER: string;
  STRIPE_SECRET_KEY: string;
  STRIPE_WEBHOOK_SECRET: string;
  LICENSE_PRIVATE_JWK: string;
  RESEND_API_KEY: string;
  /** Where cancellations that need a human and other notices go. */
  OWNER_EMAIL?: string;
  /** "on" once Stripe Tax is set up: automatic VAT and VAT ID collection in Checkout. */
  STRIPE_TAX?: string;
}

const FOUNDER_LIMIT = 500;
/**
 * The required checkbox in Checkout: terms, privacy policy and the express request to start at once,
 * with the acknowledgement that the right of withdrawal ends with that start (§ 356 (5) BGB). The
 * license email confirms it on a durable medium.
 */
const CONSENT_TEXT = (site: string) =>
  `I agree to the [Terms](${site}/agb.html) and have read the [Privacy Policy](${site}/datenschutz.html). I expressly request that SteinWall Pro starts immediately and acknowledge that I lose my [right of withdrawal](${site}/widerruf.html) once it has started. · ` +
  `Ich stimme den [AGB](${site}/agb.html) zu und habe die [Datenschutzerklärung](${site}/datenschutz.html) gelesen. Ich verlange ausdrücklich, dass SteinWall Pro sofort beginnt, und weiß, dass ich mit Beginn mein [Widerrufsrecht](${site}/widerruf.html) verliere.`;
const REFERRAL_BONUS_DAYS = 30;
const GRACE_MS = 7 * 24 * 3600 * 1000;
const PRICES = { monthly: "STRIPE_PRICE_MONTHLY", yearly: "STRIPE_PRICE_YEARLY", founder: "STRIPE_PRICE_FOUNDER" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LICENSE_COLUMNS = "id, plan, status, founder, referral_code, period_end, bonus_days";
const EMAIL = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}\.[a-z]{2,}$/i;
/** One resent key mail or cancellation mail per address in this window, so the forms cannot spam. */
const MAIL_COOLDOWN_MS = 10 * 60 * 1000;

interface LicenseRow {
  id: string;
  plan: string;
  status: string;
  founder: number;
  referral_code: string;
  period_end: string;
  bonus_days: number;
}

interface Subscription {
  id: string;
  status: string;
  /** Older Stripe API versions; newer ones (2025-03-31 and later) keep it on the items. */
  current_period_end?: number;
  items?: { data?: { current_period_end?: number }[] };
  customer: string;
  metadata?: { plan?: string };
}

function secret(env: Env, name: keyof Env): string {
  const v = env[name];
  if (typeof v !== "string" || !v) throw new Error(`missing secret ${name}`);
  const problem = secretProblem(name, v);
  if (problem) throw new Error(problem);
  return v;
}

/**
 * Catches the usual setup mistakes (swapped Stripe values, a publishable key, a broken JWK paste)
 * with a message that names the fix. Only prefixes are reported, never values.
 */
export function secretProblem(name: keyof Env, value: string | undefined): string | null {
  if (!value) return `${name} is not set`;
  const prefix = /^[a-z]{2,5}_/.exec(value)?.[0] ?? "something else";
  if (name === "STRIPE_SECRET_KEY" && !/^(sk|rk)_/.test(value)) {
    const hint = value.startsWith("whsec_") ? " (this is the webhook signing secret)" : value.startsWith("pk_") ? " (this is the publishable key)" : "";
    return `STRIPE_SECRET_KEY must start with sk_ or rk_, but starts with ${prefix}${hint}`;
  }
  if (name === "STRIPE_WEBHOOK_SECRET" && !value.startsWith("whsec_")) {
    const hint = /^(sk|rk)_/.test(value) ? " (this is the Stripe secret key)" : "";
    return `STRIPE_WEBHOOK_SECRET must start with whsec_, but starts with ${prefix}${hint}`;
  }
  if (name === "RESEND_API_KEY" && !value.startsWith("re_")) return `RESEND_API_KEY must start with re_, but starts with ${prefix}`;
  if (name === "LICENSE_PRIVATE_JWK") {
    try {
      const jwk = JSON.parse(value) as JsonWebKey;
      if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.d) return "LICENSE_PRIVATE_JWK is not an Ed25519 private key (paste the whole file)";
    } catch {
      return "LICENSE_PRIVATE_JWK is not valid JSON (paste the whole file)";
    }
  }
  return null;
}

const REQUIRED: (keyof Env)[] = ["SITE_URL", "STRIPE_PRICE_MONTHLY", "STRIPE_PRICE_YEARLY", "STRIPE_PRICE_FOUNDER", "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "LICENSE_PRIVATE_JWK", "RESEND_API_KEY"];

/** Setup check without revealing anything: which settings are missing or look wrong. */
async function health(_req: Request, env: Env): Promise<Response> {
  const problems = REQUIRED.map((name) => secretProblem(name, env[name] as string | undefined)).filter((p): p is string => p !== null);
  return json(env, { ok: problems.length === 0, problems });
}

function cors(env: Env): Record<string, string> {
  return {
    "access-control-allow-origin": env.SITE_ORIGIN || "*",
    "access-control-allow-headers": "content-type",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

function json(env: Env, body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(env), "content-type": "application/json", ...extra } });
}

let keys: { jwk: string; value: Promise<{ priv: CryptoKey; pub: CryptoKey }> } | null = null;
function signingKeys(env: Env) {
  const raw = secret(env, "LICENSE_PRIVATE_JWK");
  if (keys?.jwk !== raw) {
    const jwk = JSON.parse(raw) as JsonWebKey;
    keys = { jwk: raw, value: Promise.all([importPrivateKey(jwk), publicKeyFromPrivate(jwk)]).then(([priv, pub]) => ({ priv, pub })) };
  }
  return keys.value;
}

/** A fresh token for a license row (valid until period end plus earned referral days). */
async function tokenFor(env: Env, row: LicenseRow): Promise<string> {
  const payload: LicensePayload = {
    v: 1,
    lid: row.id,
    plan: "pro",
    exp: licenseExpiry(new Date(row.period_end), row.bonus_days).toISOString(),
    founder: Boolean(row.founder),
    ref: row.referral_code,
    iat: new Date().toISOString(),
  };
  return signLicense(payload, (await signingKeys(env)).priv);
}

/** End of the paid period, whichever Stripe API version produced the object. */
function periodEnd(sub: Subscription): string {
  const sec = sub.current_period_end ?? Math.max(0, ...(sub.items?.data ?? []).map((i) => i.current_period_end ?? 0));
  if (!sec) throw new Error(`subscription ${sub.id} has no current_period_end`);
  return new Date(sec * 1000).toISOString();
}

async function checkout(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json(env, { error: "POST only" }, 405);
  const { plan, ref } = (await req.json().catch(() => ({}))) as { plan?: string; ref?: string };
  if (!plan || !(plan in PRICES)) return json(env, { error: "unknown plan" }, 400);
  if (plan === "founder") {
    const row = await env.DB.prepare("select count(*) as n from licenses where founder = 1 and status <> 'canceled'").first<{ n: number }>();
    if ((row?.n ?? 0) >= FOUNDER_LIMIT) return json(env, { error: "founder price sold out" }, 409);
  }
  const site = secret(env, "SITE_URL").replace(/\/+$/, "");
  const referral = typeof ref === "string" && /^SW-[A-Z2-9]{8}$/.test(ref) ? ref : undefined;
  const session = await stripe<{ url: string }>(secret(env, "STRIPE_SECRET_KEY"), "POST", "/checkout/sessions", {
    mode: "subscription",
    line_items: [{ price: secret(env, PRICES[plan as keyof typeof PRICES]), quantity: 1 }],
    success_url: `${site}/license.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}/#pricing`,
    allow_promotion_codes: true,
    client_reference_id: referral,
    metadata: { plan },
    subscription_data: { metadata: { plan } },
    consent_collection: { terms_of_service: "required" },
    custom_text: { terms_of_service_acceptance: { message: CONSENT_TEXT(site) } },
    // VAT once Stripe Tax is set up in the dashboard: tax by the buyer's country, VAT ID for businesses
    // (reverse charge). Off until then, because Checkout refuses automatic tax without a registration.
    ...(env.STRIPE_TAX === "on" ? { automatic_tax: { enabled: true }, tax_id_collection: { enabled: true }, billing_address_collection: "auto" } : {}),
  });
  return json(env, { url: session.url });
}

async function stripeWebhook(req: Request, env: Env): Promise<Response> {
  const raw = await req.text();
  if (!(await verifyStripeSignature(raw, req.headers.get("stripe-signature"), secret(env, "STRIPE_WEBHOOK_SECRET")))) {
    return new Response("bad signature", { status: 400 });
  }
  const event = JSON.parse(raw) as { type: string; data: { object: Record<string, unknown> } };

  if (event.type === "checkout.session.completed") {
    const s = event.data.object as { id: string; subscription: string; customer: string; client_reference_id?: string; customer_details?: { email?: string; address?: { country?: string } }; metadata?: { plan?: string } };
    const sub = await stripe<Subscription>(secret(env, "STRIPE_SECRET_KEY"), "GET", `/subscriptions/${s.subscription}`);
    const plan = s.metadata?.plan ?? "monthly";
    const id = crypto.randomUUID();
    const row: LicenseRow = { id, plan, status: "active", founder: plan === "founder" ? 1 : 0, referral_code: newReferralCode(), period_end: periodEnd(sub), bonus_days: 0 };
    const email = s.customer_details?.email ?? null;
    const lang = langFor(s.customer_details?.address?.country);
    // Stripe may deliver an event twice: the unique checkout_session makes the second insert a no-op.
    const inserted = await env.DB.prepare(
      `insert or ignore into licenses (id, stripe_customer, stripe_subscription, checkout_session, email, plan, founder, referral_code, referred_by, period_end, lang)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, s.customer, s.subscription, s.id, email, plan, row.founder, row.referral_code, s.client_reference_id ?? null, row.period_end, lang)
      .run();

    // The key by email, so a closed success page does not lose it. Only for the first delivery of the
    // event, and a mail failure never fails the webhook (Stripe would retry the whole event).
    if (inserted.meta.changes === 1 && email) {
      try {
        await sendEmail(mailEnv(env), licenseMail(lang, email, await tokenFor(env, row), row.referral_code));
        await env.DB.prepare("update licenses set key_emailed_at = ? where id = ?").bind(new Date().toISOString(), id).run();
      } catch (err) {
        console.error("license mail failed", err);
      }
    }

    // Referral: one free month for the referrer per new paying customer (not for self-referral).
    if (inserted.meta.changes === 1 && s.client_reference_id) {
      const referrer = await env.DB.prepare("select id, stripe_customer from licenses where referral_code = ?").bind(s.client_reference_id).first<{ id: string; stripe_customer: string }>();
      if (referrer && referrer.stripe_customer !== s.customer) {
        await env.DB.batch([
          env.DB.prepare("insert into referrals (referrer_code, referred_license) values (?, ?)").bind(s.client_reference_id, id),
          env.DB.prepare("update licenses set bonus_days = bonus_days + ? where id = ?").bind(REFERRAL_BONUS_DAYS, referrer.id),
        ]);
      }
    }
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const sub = event.data.object as unknown as Subscription;
    const status = event.type === "customer.subscription.deleted" || sub.status === "canceled" ? "canceled" : sub.status === "past_due" || sub.status === "unpaid" ? "past_due" : "active";
    await env.DB.prepare("update licenses set status = ?, period_end = ? where stripe_subscription = ?").bind(status, periodEnd(sub), sub.id).run();
  }

  return new Response("ok");
}

// The session id is only known to the buyer's browser (Stripe redirects there). The webhook may
// arrive a moment later: the success page retries on 202.
async function license(req: Request, env: Env): Promise<Response> {
  const sessionId = new URL(req.url).searchParams.get("session_id") ?? "";
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return json(env, { error: "invalid session" }, 400);
  const row = await env.DB.prepare(`select ${LICENSE_COLUMNS} from licenses where checkout_session = ?`).bind(sessionId).first<LicenseRow>();
  if (!row) return json(env, { pending: true }, 202);
  return json(env, { token: await tokenFor(env, row), referralCode: row.referral_code });
}

async function licenseRefresh(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json(env, { error: "POST only" }, 405);
  const { token } = (await req.json().catch(() => ({}))) as { token?: string };
  const payload = token ? await verifyLicense(token, (await signingKeys(env)).pub) : null;
  if (!payload) return json(env, { error: "invalid token" }, 400);
  const row = await env.DB.prepare(`select ${LICENSE_COLUMNS} from licenses where id = ?`).bind(payload.lid).first<LicenseRow>();
  if (!row) return json(env, { error: "unknown license" }, 410);
  const ends = licenseExpiry(new Date(row.period_end), row.bonus_days).getTime();
  if (row.status === "canceled" && ends + GRACE_MS < Date.now()) return json(env, { error: "license ended" }, 410);
  return json(env, { token: await tokenFor(env, row) });
}

// Nothing but these three fields is accepted or stored: no prompts, code, paths, keys or IP addresses.
async function telemetry(req: Request, env: Env): Promise<Response> {
  if (req.method === "GET") {
    const row = await env.DB.prepare("select coalesce(sum(saved_usd), 0) as total, count(distinct install_id) as installs from telemetry_daily").first<{ total: number; installs: number }>();
    return json(env, { totalUsd: Math.round((row?.total ?? 0) * 100) / 100, installs: row?.installs ?? 0 }, 200, { "cache-control": "public, max-age=300" });
  }
  if (req.method !== "POST") return json(env, { error: "GET or POST" }, 405);
  const body = (await req.json().catch(() => ({}))) as { installId?: string; day?: string; savedUsd?: number };
  const day = body.day && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : null;
  const age = day ? (Date.now() - new Date(`${day}T00:00:00Z`).getTime()) / 86_400_000 : NaN;
  if (!body.installId || !UUID.test(body.installId) || !day || !(age >= -1 && age <= 8)) return json(env, { error: "invalid" }, 400);
  if (typeof body.savedUsd !== "number" || !Number.isFinite(body.savedUsd) || body.savedUsd < 0 || body.savedUsd > 1000) return json(env, { error: "invalid" }, 400);
  await env.DB.prepare(
    `insert into telemetry_daily (install_id, day, saved_usd) values (?, ?, ?)
     on conflict (install_id, day) do update set saved_usd = excluded.saved_usd, received_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
  )
    .bind(body.installId.toLowerCase(), day, Math.round(body.savedUsd * 100) / 100)
    .run();
  return json(env, { ok: true });
}

function mailEnv(env: Env) {
  return { RESEND_API_KEY: secret(env, "RESEND_API_KEY"), OWNER_EMAIL: env.OWNER_EMAIL };
}

const recent = (iso: string | null | undefined, now = Date.now()) => !!iso && now - new Date(iso).getTime() < MAIL_COOLDOWN_MS;

async function jsonBody<T>(req: Request): Promise<Partial<T>> {
  return (await req.json().catch(() => ({}))) as Partial<T>;
}

// The answer never says whether the address has a license, so the form cannot be used to probe.
async function licenseResend(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json(env, { error: "POST only" }, 405);
  const { email } = await jsonBody<{ email: string }>(req);
  if (typeof email !== "string" || !EMAIL.test(email.trim())) return json(env, { error: "invalid email" }, 400);
  const address = email.trim();
  const neutral = json(env, { ok: true, message: "If this address has an active SteinWall Pro license, the key is on its way." });
  const { results } = await env.DB.prepare(`select ${LICENSE_COLUMNS}, lang, last_resend_at from licenses where lower(email) = lower(?) and status <> 'canceled'`)
    .bind(address)
    .all<LicenseRow & { lang: Lang | null; last_resend_at: string | null }>();
  if (!results.length || results.some((r) => recent(r.last_resend_at))) return neutral;
  const tokens = await Promise.all(results.map((r) => tokenFor(env, r)));
  await sendEmail(mailEnv(env), resendMail(results[0]!.lang ?? "en", address, tokens));
  const now = new Date().toISOString();
  await env.DB.batch(results.map((r) => env.DB.prepare("update licenses set last_resend_at = ? where id = ?").bind(now, r.id)));
  return neutral;
}

async function portal(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json(env, { error: "POST only" }, 405);
  const { token } = await jsonBody<{ token: string }>(req);
  const payload = typeof token === "string" ? await verifyLicense(token, (await signingKeys(env)).pub) : null;
  if (!payload) return json(env, { error: "invalid license key" }, 400);
  const row = await env.DB.prepare("select stripe_customer from licenses where id = ?").bind(payload.lid).first<{ stripe_customer: string | null }>();
  if (!row?.stripe_customer) return json(env, { error: "unknown license" }, 404);
  const session = await stripe<{ url: string }>(secret(env, "STRIPE_SECRET_KEY"), "POST", "/billing_portal/sessions", {
    customer: row.stripe_customer,
    return_url: secret(env, "SITE_URL").replace(/\/+$/, ""),
  });
  return json(env, { url: session.url });
}

interface CancelRow {
  id: string;
  plan: string;
  stripe_subscription: string | null;
  lang: Lang | null;
  email: string | null;
}

/**
 * Cancel button (§ 312k BGB): no login, identified by email (plus the license key if the subscription
 * runs under another address). Ends every active subscription at the end of its paid period and
 * always confirms receipt by email. Unmatched or extraordinary cancellations go to the owner.
 */
async function cancel(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return json(env, { error: "POST only" }, 405);
  const body = await jsonBody<{ email: string; kind: string; reason: string; key: string }>(req);
  if (typeof body.email !== "string" || !EMAIL.test(body.email.trim())) return json(env, { error: "invalid email" }, 400);
  const email = body.email.trim();
  const kind = body.kind === "extraordinary" ? "extraordinary" : "ordinary";
  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, 1000) : "";
  const receivedAt = new Date();

  const { results } = await env.DB.prepare("select id, plan, stripe_subscription, lang, email from licenses where lower(email) = lower(?) and status <> 'canceled'").bind(email).all<CancelRow>();
  const rows = [...results];
  const keyPayload = typeof body.key === "string" && body.key.trim() ? await verifyLicense(body.key, (await signingKeys(env)).pub) : null;
  if (keyPayload && !rows.some((r) => r.id === keyPayload.lid)) {
    const byKey = await env.DB.prepare("select id, plan, stripe_subscription, lang, email from licenses where id = ? and status <> 'canceled'").bind(keyPayload.lid).first<CancelRow>();
    if (byKey) rows.push(byKey);
  }

  const contracts: CancelledContract[] = [];
  const failures: string[] = [];
  for (const r of rows) {
    if (!r.stripe_subscription) continue;
    try {
      const sub = await stripe<Subscription>(secret(env, "STRIPE_SECRET_KEY"), "POST", `/subscriptions/${r.stripe_subscription}`, { cancel_at_period_end: true });
      contracts.push({ plan: r.plan, endsAt: periodEnd(sub) });
    } catch (err) {
      failures.push(`${r.stripe_subscription}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const previous = await env.DB.prepare("select received_at from cancellations where lower(email) = lower(?) order by received_at desc limit 1").bind(email).first<{ received_at: string }>();
  await env.DB.prepare("insert into cancellations (received_at, email, kind, reason, matched) values (?, ?, ?, ?, ?)")
    .bind(receivedAt.toISOString(), email, kind, reason || null, contracts.length)
    .run();

  const lang: Lang = rows[0]?.lang ?? (req.headers.get("accept-language")?.toLowerCase().startsWith("de") ? "de" : "en");
  try {
    // The confirmation goes to the address that was entered, so the real customer always learns about it.
    if (!recent(previous?.received_at, receivedAt.getTime()) || contracts.length) await sendEmail(mailEnv(env), cancellationMail(lang, email, receivedAt, kind, contracts, reason || undefined));
    if (env.OWNER_EMAIL && (!contracts.length || kind === "extraordinary" || failures.length)) {
      const text = `Cancellation received ${receivedAt.toISOString()}\nEmail: ${email}\nType: ${kind}\nReason: ${reason || "-"}\nEnded at period end: ${contracts.map((c) => `${c.plan} until ${c.endsAt}`).join(", ") || "none"}\nStripe errors: ${failures.join("; ") || "none"}`;
      await sendEmail(mailEnv(env), ownerMail(env.OWNER_EMAIL, contracts.length ? `Cancellation (${kind})` : "Cancellation without matching subscription", text));
    }
  } catch (err) {
    console.error("cancellation mail failed", err);
  }
  return json(env, { ok: true, receivedAt: receivedAt.toISOString(), kind, contracts });
}

const ROUTES: Record<string, (req: Request, env: Env) => Promise<Response>> = {
  "/checkout": checkout,
  "/stripe-webhook": stripeWebhook,
  "/license": license,
  "/license-refresh": licenseRefresh,
  "/license/resend": licenseResend,
  "/portal": portal,
  "/cancel": cancel,
  "/telemetry": telemetry,
  "/health": health,
};

export async function handle(req: Request, env: Env): Promise<Response> {
  const route = ROUTES[new URL(req.url).pathname.replace(/\/+$/, "")];
  if (!route) return json(env, { error: "not found" }, 404);
  if (req.method === "OPTIONS") return new Response(null, { headers: cors(env) });
  try {
    return await route(req, env);
  } catch (err) {
    // Logged for `wrangler tail` and kept for the daily self-check; a 500 also makes Stripe retry the webhook later.
    console.error(err);
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 500);
    await env.DB.prepare("insert into errors (at, route, message) values (?, ?, ?)").bind(new Date().toISOString(), new URL(req.url).pathname, message).run().catch(() => {});
    return json(env, { error: "internal error" }, 500);
  }
}

const DAY_MS = 24 * 3600 * 1000;

/**
 * Daily self-check (cron): settings, the Stripe key and prices, and the errors of the last 24 hours.
 * Emails the owner only when something is wrong; returns the problems found.
 */
export async function selfCheck(env: Env, now = Date.now()): Promise<string[]> {
  const problems = REQUIRED.map((name) => secretProblem(name, env[name] as string | undefined)).filter((p): p is string => p !== null);
  if (!problems.some((p) => p.startsWith("STRIPE_SECRET_KEY"))) {
    for (const plan of Object.keys(PRICES) as (keyof typeof PRICES)[]) {
      try {
        const price = await stripe<{ active: boolean }>(secret(env, "STRIPE_SECRET_KEY"), "GET", `/prices/${secret(env, PRICES[plan])}`);
        if (!price.active) problems.push(`Stripe price for ${plan} is inactive`);
      } catch (err) {
        problems.push(`Stripe check for ${plan} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const since = new Date(now - DAY_MS).toISOString();
  const { results: errors } = await env.DB.prepare("select at, route, message from errors where at >= ? order by at desc limit 20").bind(since).all<{ at: string; route: string; message: string }>();
  if (errors.length) problems.push(`${errors.length} error(s) in the last 24 hours:\n${errors.map((e) => `  ${e.at} ${e.route}: ${e.message}`).join("\n")}`);
  await env.DB.prepare("delete from errors where at < ?").bind(new Date(now - 30 * DAY_MS).toISOString()).run();
  if (problems.length && env.OWNER_EMAIL && !problems.some((p) => p.startsWith("RESEND_API_KEY"))) {
    await sendEmail(mailEnv(env), ownerMail(env.OWNER_EMAIL, "Daily self-check found problems", `${problems.join("\n\n")}\n\nDetails: https://api.steinwall.dev/health and \`npx wrangler tail\` in backend/worker.`));
  }
  return problems;
}

export default {
  fetch: handle,
  async scheduled(_event: unknown, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }) {
    ctx.waitUntil(selfCheck(env));
  },
};
