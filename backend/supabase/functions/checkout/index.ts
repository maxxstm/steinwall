// POST { plan: "monthly" | "yearly" | "founder", ref?: string } -> { url } of a Stripe Checkout page.
// Founder price (5 $/month for life) only while fewer than FOUNDER_LIMIT founder licenses exist.
import { cors, db, env, json } from "../_shared/http.ts";
import { stripe } from "../_shared/stripe.ts";

const FOUNDER_LIMIT = 500;
const PRICES: Record<string, string> = {
  monthly: "STRIPE_PRICE_MONTHLY", // 9 $ / month
  yearly: "STRIPE_PRICE_YEARLY", // 90 $ / year
  founder: "STRIPE_PRICE_FOUNDER", // 5 $ / month, first 500
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const { plan, ref } = (await req.json().catch(() => ({}))) as { plan?: string; ref?: string };
  if (!plan || !PRICES[plan]) return json({ error: "unknown plan" }, 400);

  if (plan === "founder") {
    const { data } = await db().from("founder_count").select("n").single();
    if ((data?.n ?? 0) >= FOUNDER_LIMIT) return json({ error: "founder price sold out" }, 409);
  }
  const site = env("SITE_URL");
  const referral = typeof ref === "string" && /^SW-[A-Z2-9]{8}$/.test(ref) ? ref : undefined;
  const session = await stripe<{ url: string }>(env("STRIPE_SECRET_KEY"), "POST", "/checkout/sessions", {
    mode: "subscription",
    line_items: [{ price: env(PRICES[plan]!), quantity: 1 }],
    success_url: `${site}/license.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${site}/#pricing`,
    allow_promotion_codes: true,
    client_reference_id: referral,
    metadata: { plan },
    subscription_data: { metadata: { plan } },
  });
  return json({ url: session.url });
});
