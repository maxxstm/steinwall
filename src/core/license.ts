/**
 * Pro licensing. A license is a signed token issued by the SteinWall backend after a Stripe
 * purchase: `SW1.<base64url payload>.<base64url Ed25519 signature>`. It is verified offline against
 * the public key below, so Pro works without network. Every few days the plugin refreshes the token
 * online (renewals, referral months, cancellations); after expiry a short grace period applies.
 * New installs get a 5-day Pro trial, counted locally from the first start.
 */
import { createPublicKey, randomUUID, verify } from "node:crypto";
import { join } from "node:path";
import { readJson, writeJson } from "./fsutil.js";
import { stateDir } from "./paths.js";
import { LICENSE_PUBLIC_KEY_SPKI } from "./license-key.js";

export const TRIAL_DAYS = 5;
const DAY = 24 * 3600 * 1000;
/** Pro keeps working this long past the paid period if the refresh cannot reach the server. */
const GRACE_DAYS = 7;
export const REFRESH_EVERY_DAYS = 3;

export interface LicensePayload {
  v: 1;
  /** License id (opaque, assigned by the backend). */
  lid: string;
  plan: "pro";
  /** End of the paid period (ISO date). */
  exp: string;
  founder?: boolean;
  /** The holder's referral code. */
  ref?: string;
  iat: string;
}

interface LicenseState {
  token?: string;
  refreshedAt?: number;
}

interface InstallState {
  installId: string;
  installedAt: number;
}

const licenseFile = () => join(stateDir(), "license.json");
const installFile = () => join(stateDir(), "install.json");

/** Random install id and first-start time (for the trial). Never derived from the machine. */
export function installInfo(now = Date.now()): InstallState {
  const existing = readJson<InstallState | null>(installFile(), null);
  if (existing?.installId) return existing;
  const fresh = { installId: randomUUID(), installedAt: now };
  writeJson(installFile(), fresh);
  return fresh;
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Payload of a valid signature, or null. Expiry is checked separately. */
export function verifyToken(token: string, publicKeySpkiB64: string = LICENSE_PUBLIC_KEY_SPKI): LicensePayload | null {
  if (!publicKeySpkiB64) return null;
  const parts = token.trim().split(".");
  if (parts.length !== 3 || parts[0] !== "SW1") return null;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpkiB64, "base64"), format: "der", type: "spki" });
    const ok = verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), key, b64url(parts[2]!));
    if (!ok) return null;
    const payload = JSON.parse(b64url(parts[1]!).toString("utf8")) as LicensePayload;
    return payload.v === 1 && payload.plan === "pro" && typeof payload.exp === "string" ? payload : null;
  } catch {
    return null;
  }
}

export type ProReason = "license" | "grace" | "trial" | "none";

export interface ProStatus {
  pro: boolean;
  reason: ProReason;
  trialDaysLeft: number;
  license?: LicensePayload;
  /** Days until the license's paid period ends (negative in grace). */
  licenseDaysLeft?: number;
}

export function proStatus(now = Date.now(), publicKey: string = LICENSE_PUBLIC_KEY_SPKI): ProStatus {
  const install = installInfo(now);
  const trialDaysLeft = Math.max(0, Math.ceil((install.installedAt + TRIAL_DAYS * DAY - now) / DAY));
  const token = readJson<LicenseState>(licenseFile(), {}).token;
  const license = token ? verifyToken(token, publicKey) : null;
  if (license) {
    const left = (new Date(license.exp).getTime() - now) / DAY;
    if (left >= 0) return { pro: true, reason: "license", trialDaysLeft, license, licenseDaysLeft: Math.ceil(left) };
    if (left >= -GRACE_DAYS) return { pro: true, reason: "grace", trialDaysLeft, license, licenseDaysLeft: Math.floor(left) };
  }
  if (trialDaysLeft > 0) return { pro: true, reason: "trial", trialDaysLeft, ...(license ? { license } : {}) };
  return { pro: false, reason: "none", trialDaysLeft: 0, ...(license ? { license } : {}) };
}

export function isPro(now = Date.now()): boolean {
  return proStatus(now).pro;
}

/** Store a license token after checking its signature. Returns the payload or throws. */
export function activateLicense(token: string, publicKey: string = LICENSE_PUBLIC_KEY_SPKI): LicensePayload {
  const payload = verifyToken(token, publicKey);
  if (!payload) throw new Error(publicKey ? "invalid license key" : "this build has no license public key yet");
  writeJson(licenseFile(), { token: token.trim(), refreshedAt: Date.now() } satisfies LicenseState);
  return payload;
}

export function deactivateLicense(): void {
  writeJson(licenseFile(), {});
}

/** A link to the Stripe customer portal (payment method, invoices) for the activated license. */
export async function portalUrl(apiUrl: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const token = readJson<LicenseState>(licenseFile(), {}).token;
  if (!token) throw new Error("no license activated");
  if (!apiUrl) throw new Error("no backend configured (license.apiUrl)");
  const res = await fetchImpl(`${apiUrl.replace(/\/$/, "")}/portal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
  if (!res.ok || !body.url) throw new Error(body.error ?? `portal request failed (${res.status})`);
  return body.url;
}

export function refreshDue(now = Date.now()): boolean {
  const state = readJson<LicenseState>(licenseFile(), {});
  return !!state.token && now - (state.refreshedAt ?? 0) > REFRESH_EVERY_DAYS * DAY;
}

/**
 * Ask the backend for a current token (renewal, referral months, cancellation). Sends only the
 * token itself. Network failures keep the existing token; the grace period covers offline use.
 */
export async function refreshLicense(apiUrl: string, fetchImpl: typeof fetch = fetch, publicKey: string = LICENSE_PUBLIC_KEY_SPKI): Promise<"updated" | "unchanged" | "revoked" | "offline"> {
  const state = readJson<LicenseState>(licenseFile(), {});
  if (!state.token || !apiUrl) return "unchanged";
  try {
    const res = await fetchImpl(`${apiUrl.replace(/\/$/, "")}/license-refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: state.token }),
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 410) {
      writeJson(licenseFile(), {});
      return "revoked";
    }
    if (!res.ok) return "offline";
    const body = (await res.json()) as { token?: string };
    if (body.token && verifyToken(body.token, publicKey)) {
      const changed = body.token !== state.token;
      writeJson(licenseFile(), { token: body.token, refreshedAt: Date.now() } satisfies LicenseState);
      return changed ? "updated" : "unchanged";
    }
    return "offline";
  } catch {
    return "offline";
  }
}
