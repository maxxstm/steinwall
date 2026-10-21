// GET ?session_id=cs_... -> { token, referralCode } for the success page after checkout.
// The session id is only known to the buyer's browser (Stripe redirects there), and the
// session must be paid. The webhook may arrive a moment later: the page retries on 202.
import { cors, db, json, type LicenseRow, tokenFor } from "../_shared/http.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const sessionId = new URL(req.url).searchParams.get("session_id") ?? "";
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) return json({ error: "invalid session" }, 400);
  const { data } = await db().from("licenses").select("id, plan, status, founder, referral_code, period_end, bonus_days").eq("checkout_session", sessionId).maybeSingle();
  if (!data) return json({ pending: true }, 202);
  const row = data as LicenseRow;
  return json({ token: await tokenFor(row), referralCode: row.referral_code });
});
