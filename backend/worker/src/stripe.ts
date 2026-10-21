// Minimal Stripe helpers without the SDK: webhook signature check and form-encoded API calls.

const enc = new TextEncoder();

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Verify the `Stripe-Signature` header ("t=<unix>,v1=<hex hmac>[,v1=...]") against the raw body.
 * Rejects signatures older than `toleranceSec` to prevent replays.
 */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): Promise<boolean> {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.split("=") as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !signatures.length || Math.abs(nowSec - Number(t)) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = hex(await crypto.subtle.sign("HMAC", key, enc.encode(`${t}.${rawBody}`)));
  return signatures.some((s) => timingSafeEqual(s, expected));
}

/** Stripe's form encoding, including nested objects and arrays (line_items[0][price]=...). */
export function formEncode(obj: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") out.push(...formEncode(v as Record<string, unknown>, key));
    else out.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return out;
}

export async function stripe<T>(secretKey: string, method: "GET" | "POST", path: string, params?: Record<string, unknown>): Promise<T> {
  const body = params && method === "POST" ? formEncode(params).join("&") : undefined;
  const query = params && method === "GET" ? `?${formEncode(params).join("&")}` : "";
  const res = await fetch(`https://api.stripe.com/v1${path}${query}`, {
    method,
    headers: { authorization: `Bearer ${secretKey}`, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok) throw new Error(`stripe ${path}: ${json.error?.message ?? res.status}`);
  return json;
}
