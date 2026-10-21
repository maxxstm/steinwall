// Shared helpers for the Edge Functions (Deno).
import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { importPrivateKey, licenseExpiry, type LicensePayload, publicKeyFromPrivate, signLicense } from "./license.ts";

export const SITE_ORIGIN = Deno.env.get("SITE_ORIGIN") ?? "*";

export const cors = {
  "access-control-allow-origin": SITE_ORIGIN,
  "access-control-allow-headers": "content-type",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });
}

export function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing secret ${name}`);
  return v;
}

/** Service-role client: functions are the only path to the database. */
export function db() {
  return createClient(env("SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
}

export interface LicenseRow {
  id: string;
  plan: string;
  status: string;
  founder: boolean;
  referral_code: string;
  period_end: string;
  bonus_days: number;
}

let keys: Promise<{ priv: CryptoKey; pub: CryptoKey }> | null = null;
export function signingKeys() {
  keys ??= (async () => {
    const jwk = JSON.parse(env("LICENSE_PRIVATE_JWK")) as JsonWebKey;
    return { priv: await importPrivateKey(jwk), pub: await publicKeyFromPrivate(jwk) };
  })();
  return keys;
}

/** A fresh token for a license row (valid until period end plus earned referral days). */
export async function tokenFor(row: LicenseRow): Promise<string> {
  const payload: LicensePayload = {
    v: 1,
    lid: row.id,
    plan: "pro",
    exp: licenseExpiry(new Date(row.period_end), row.bonus_days).toISOString(),
    founder: row.founder,
    ref: row.referral_code,
    iat: new Date().toISOString(),
  };
  return signLicense(payload, (await signingKeys()).priv);
}
