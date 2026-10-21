/**
 * Public key (Ed25519, SPKI DER, base64) that license tokens are verified against.
 * Empty until the production key pair exists: run `node scripts/generate-license-keys.mjs`, which
 * writes the public key here and the private key to a file outside the repository for the backend.
 * While empty, no license validates and only the trial unlocks Pro.
 */
export const LICENSE_PUBLIC_KEY_SPKI = "MCowBQYDK2VwAyEAeTyLpRbImOt1dy1ZkiauW/0GmGwlVOOVHy6FLsdzXA0=";
