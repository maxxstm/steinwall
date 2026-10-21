// One-time setup for licensing: creates the Ed25519 key pair.
//  - The public key goes into src/core/license-key.ts (shipped with the plugin).
//  - The private key is written as a JWK to the path given as the first argument (default:
//    ~/steinwall-license-private.jwk.json). It must never be committed. Set it as the backend
//    secret LICENSE_PRIVATE_JWK, e.g. `supabase secrets set LICENSE_PRIVATE_JWK="$(cat <file>)"`.
// Refuses to overwrite an existing public key, so a running product does not lose its keys by accident.
import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const keyFile = "src/core/license-key.ts";
const out = process.argv[2] ?? join(homedir(), "steinwall-license-private.jwk.json");
if (/LICENSE_PUBLIC_KEY_SPKI = "[^"]+"/.test(readFileSync(keyFile, "utf8"))) {
  console.error(`${keyFile} already has a public key. Remove it by hand if you really want a new key pair (all issued licenses become invalid).`);
  process.exit(1);
}
if (existsSync(out)) {
  console.error(`${out} already exists. Not overwriting.`);
  process.exit(1);
}
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64");
writeFileSync(out, JSON.stringify(privateKey.export({ format: "jwk" })), { mode: 0o600 });
writeFileSync(keyFile, readFileSync(keyFile, "utf8").replace('LICENSE_PUBLIC_KEY_SPKI = ""', `LICENSE_PUBLIC_KEY_SPKI = "${spki}"`));
console.log(`Public key written to ${keyFile}. Private key (JWK) written to ${out}. Rebuild with npm run build.`);
