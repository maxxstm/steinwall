// POST { token } -> { token } with the current period (renewals, referral months) or 410 when the
// license has ended. The plugin calls this every few days; it only sends the token it already has.
import { cors, db, json, type LicenseRow, signingKeys, tokenFor } from "../_shared/http.ts";
import { licenseExpiry, verifyLicense } from "../_shared/license.ts";

const GRACE_MS = 7 * 24 * 3600 * 1000;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const { token } = (await req.json().catch(() => ({}))) as { token?: string };
  const payload = token ? await verifyLicense(token, (await signingKeys()).pub) : null;
  if (!payload) return json({ error: "invalid token" }, 400);
  const { data } = await db().from("licenses").select("id, plan, status, founder, referral_code, period_end, bonus_days").eq("id", payload.lid).maybeSingle();
  if (!data) return json({ error: "unknown license" }, 410);
  const row = data as LicenseRow;
  const ends = licenseExpiry(new Date(row.period_end), row.bonus_days).getTime();
  if (row.status === "canceled" && ends + GRACE_MS < Date.now()) return json({ error: "license ended" }, 410);
  return json({ token: await tokenFor(row) });
});
