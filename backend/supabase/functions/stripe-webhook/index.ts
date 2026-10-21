// Stripe webhook: creates licenses on purchase, keeps period and status in sync, credits referrals.
// Events: checkout.session.completed, customer.subscription.updated, customer.subscription.deleted.
import { db, env } from "../_shared/http.ts";
import { newReferralCode } from "../_shared/license.ts";
import { stripe, verifyStripeSignature } from "../_shared/stripe.ts";

const REFERRAL_BONUS_DAYS = 30;

interface Subscription {
  id: string;
  status: string;
  /** Older Stripe API versions; newer ones (2025-03-31 and later) keep it on the items. */
  current_period_end?: number;
  items?: { data?: { current_period_end?: number }[] };
  customer: string;
  metadata?: { plan?: string };
}

/** End of the paid period, whichever Stripe API version produced the object. */
function periodEnd(sub: Subscription): string {
  const sec = sub.current_period_end ?? Math.max(0, ...(sub.items?.data ?? []).map((i) => i.current_period_end ?? 0));
  if (!sec) throw new Error(`subscription ${sub.id} has no current_period_end`);
  return new Date(sec * 1000).toISOString();
}

Deno.serve(async (req) => {
  const raw = await req.text();
  if (!(await verifyStripeSignature(raw, req.headers.get("stripe-signature"), env("STRIPE_WEBHOOK_SECRET")))) {
    return new Response("bad signature", { status: 400 });
  }
  const event = JSON.parse(raw) as { type: string; data: { object: Record<string, unknown> } };
  const client = db();

  if (event.type === "checkout.session.completed") {
    const s = event.data.object as { id: string; subscription: string; customer: string; client_reference_id?: string; customer_details?: { email?: string }; metadata?: { plan?: string } };
    const sub = await stripe<Subscription>(env("STRIPE_SECRET_KEY"), "GET", `/subscriptions/${s.subscription}`);
    const plan = s.metadata?.plan ?? "monthly";
    const id = crypto.randomUUID();
    const { error } = await client.from("licenses").upsert(
      {
        id,
        stripe_customer: s.customer,
        stripe_subscription: s.subscription,
        checkout_session: s.id,
        email: s.customer_details?.email ?? null,
        plan,
        founder: plan === "founder",
        referral_code: newReferralCode(),
        referred_by: s.client_reference_id ?? null,
        period_end: periodEnd(sub),
      },
      { onConflict: "checkout_session", ignoreDuplicates: true }, // Stripe may deliver an event twice
    );
    if (error) return new Response(error.message, { status: 500 });

    // Referral: one free month for the referrer per new paying customer (not for self-referral).
    if (s.client_reference_id) {
      const { data: referrer } = await client.from("licenses").select("id, bonus_days, stripe_customer").eq("referral_code", s.client_reference_id).maybeSingle();
      if (referrer && referrer.stripe_customer !== s.customer) {
        const { error: refError } = await client.from("referrals").insert({ referrer_code: s.client_reference_id, referred_license: id });
        if (!refError) await client.from("licenses").update({ bonus_days: referrer.bonus_days + REFERRAL_BONUS_DAYS }).eq("id", referrer.id);
      }
    }
  }

  if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
    const sub = event.data.object as unknown as Subscription;
    const status = event.type === "customer.subscription.deleted" || sub.status === "canceled" ? "canceled" : sub.status === "past_due" || sub.status === "unpaid" ? "past_due" : "active";
    await client.from("licenses").update({ status, period_end: periodEnd(sub) }).eq("stripe_subscription", sub.id);
  }

  return new Response("ok");
});
