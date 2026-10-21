// Opt-in savings counter.
// POST { installId: uuid, day: "YYYY-MM-DD", savedUsd: number } stores one number per install and day.
// GET -> { totalUsd, installs } for the public counter on the website.
// Nothing else is accepted or stored: no prompts, code, paths, keys or IP addresses.
import { cors, db, json } from "../_shared/http.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const client = db();
  if (req.method === "GET") {
    const { data } = await client.from("savings_counter").select("total_usd, installs").single();
    return new Response(JSON.stringify({ totalUsd: Number(data?.total_usd ?? 0), installs: data?.installs ?? 0 }), {
      headers: { ...cors, "content-type": "application/json", "cache-control": "public, max-age=300" },
    });
  }
  if (req.method !== "POST") return json({ error: "GET or POST" }, 405);
  const body = (await req.json().catch(() => ({}))) as { installId?: string; day?: string; savedUsd?: number };
  const day = body.day && /^\d{4}-\d{2}-\d{2}$/.test(body.day) ? body.day : null;
  const today = new Date();
  const age = day ? (today.getTime() - new Date(`${day}T00:00:00Z`).getTime()) / 86_400_000 : NaN;
  if (!body.installId || !UUID.test(body.installId) || !day || !(age >= -1 && age <= 8)) return json({ error: "invalid" }, 400);
  if (typeof body.savedUsd !== "number" || !Number.isFinite(body.savedUsd) || body.savedUsd < 0 || body.savedUsd > 1000) return json({ error: "invalid" }, 400);
  const { error } = await client.from("telemetry_daily").upsert({ install_id: body.installId, day, saved_usd: Math.round(body.savedUsd * 100) / 100 });
  return error ? json({ error: "store failed" }, 500) : json({ ok: true });
});
