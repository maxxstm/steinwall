/** Files that hold credentials. Matching is on normalized, lower-cased paths. */
const EXAMPLE_SUFFIX = /\.(example|sample|template|dist|defaults?|schema)$/;
const KEY_EXTENSIONS = /\.(pem|key|p12|pfx|jks|keystore|ppk|kdbx)$/;
const SSH_PRIVATE_KEY = /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/;
const SECRET_BASENAMES = new Set([
    ".netrc", "_netrc", ".npmrc", ".pypirc", ".git-credentials", ".vault-token", ".pgpass",
    "credentials.json", "client_secret.json", "token.json",
]);
const SECRET_PATH_PARTS = [
    "/.aws/credentials", "/.docker/config.json", "/.kube/config", "/.gnupg/", "/.config/gh/hosts.yml",
    "/.config/gcloud/", "/.azure/", "/.password-store/",
];
const SSH_HARMLESS = new Set(["known_hosts", "known_hosts.old", "config", "authorized_keys"]);
function normalize(path) {
    return path.trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/").toLowerCase();
}
export function isSecretPath(rawPath) {
    const p = normalize(rawPath);
    if (!p || p.length > 4096)
        return false;
    const base = p.replace(/\/+$/, "").split("/").pop() ?? "";
    // .env, .env.local, .envrc, prod.env, also globs like ".env*"
    if (base.startsWith(".env") || /^[\w.-]+\.env$/.test(base)) {
        return !EXAMPLE_SUFFIX.test(base);
    }
    if (base === ".ssh" || p.includes("/.ssh/") || p.startsWith(".ssh/")) {
        return base === ".ssh" || !(SSH_HARMLESS.has(base) || base.endsWith(".pub"));
    }
    if (SSH_PRIVATE_KEY.test(base) || KEY_EXTENSIONS.test(base) || SECRET_BASENAMES.has(base))
        return true;
    if (/^secrets?\.(json|ya?ml|toml|env)$/.test(base) || /^service[-_]?account.*\.json$/.test(base))
        return true;
    const withSlash = p.startsWith("/") ? p : `/${p}`;
    return SECRET_PATH_PARTS.some((part) => withSlash.includes(part));
}
