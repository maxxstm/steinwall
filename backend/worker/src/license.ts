// License tokens, shared by the Worker and tested with Node (Web Crypto in both).
// Format: "SW1." + base64url(JSON payload) + "." + base64url(Ed25519 signature over the first two parts).
// The plugin verifies offline with the matching public key (src/core/license-key.ts).

export interface LicensePayload {
  v: 1;
  lid: string;
  plan: "pro";
  exp: string;
  founder?: boolean;
  ref?: string;
  iat: string;
}

const enc = new TextEncoder();

export function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The private key is stored as a JWK secret (LICENSE_PRIVATE_JWK). */
export async function importPrivateKey(jwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["sign"]);
}

export async function publicKeyFromPrivate(jwk: JsonWebKey): Promise<CryptoKey> {
  const { d: _d, key_ops: _ops, ...pub } = jwk;
  return crypto.subtle.importKey("jwk", { ...pub, key_ops: ["verify"] }, { name: "Ed25519" }, false, ["verify"]);
}

export async function signLicense(payload: LicensePayload, privateKey: CryptoKey): Promise<string> {
  const head = `SW1.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, enc.encode(head)));
  return `${head}.${b64url(sig)}`;
}

export async function verifyLicense(token: string, publicKey: CryptoKey): Promise<LicensePayload | null> {
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "SW1") return null;
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, publicKey, fromB64url(parts[2]!), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  try {
    return JSON.parse(new TextDecoder().decode(fromB64url(parts[1]!))) as LicensePayload;
  } catch {
    return null;
  }
}

/** Paid period end plus earned referral days. */
export function licenseExpiry(periodEnd: Date, bonusDays: number): Date {
  return new Date(periodEnd.getTime() + bonusDays * 24 * 3600 * 1000);
}

/** Short, unambiguous referral codes (no 0/O/1/I). */
export function newReferralCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `SW-${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("")}`;
}
