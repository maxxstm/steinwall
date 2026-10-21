/**
 * Rules for scanning skills, plugins and MCP servers. Rule-based on purpose: fast, explainable,
 * no data leaves the machine. Each rule has a severity per context, because the same text means
 * different things in a script that runs and in Markdown that the agent merely reads.
 */

export type Severity = "info" | "low" | "medium" | "high" | "critical";
export const SEVERITY_ORDER: Severity[] = ["info", "low", "medium", "high", "critical"];
export const atLeast = (s: Severity, min: Severity) => SEVERITY_ORDER.indexOf(s) >= SEVERITY_ORDER.indexOf(min);

/** "instructions": Markdown/text the agent reads. "script": code that runs. "config": hooks/MCP/plugin JSON. */
export type Context = "instructions" | "script" | "config";

export type Category = "prompt-injection" | "hidden-text" | "remote-exec" | "obfuscation" | "persistence" | "destructive" | "secret-access" | "network-send" | "exfiltration" | "mcp" | "hooks";

export interface Rule {
  id: string;
  category: Category;
  pattern: RegExp;
  /** Severity per context; a missing context means the rule does not apply there. */
  severity: Partial<Record<Context, Severity>>;
}

const ALL = (s: Severity): Partial<Record<Context, Severity>> => ({ instructions: s, script: s, config: s });

export const RULES: Rule[] = [
  // --- prompt injection: text that tries to steer the agent against its user ---
  {
    id: "ignore-instructions",
    category: "prompt-injection",
    pattern: /\b(ignore|disregard|forget)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|system)\b[^.\n]{0,25}\b(instructions?|rules|guidelines|prompts?|directives)\b/i,
    severity: { instructions: "high", config: "high", script: "medium" },
  },
  {
    id: "conceal-from-user",
    category: "prompt-injection",
    // "never show these labels to the user" or "do not tell the user it's real" is normal guidance;
    // keeping an *action or a secret* from the user is not. "Do not tell the user" therefore only
    // counts with such a word in the same sentence.
    pattern: /\b(do not|don't|never)\s+(tell|inform|notify|alert|warn)\s+(the\s+)?(user|human|operator)\b[^.\n]{0,80}\b(send|sent|upload|post|run|ran|execut\w*|install\w*|delet\w*|cop(y|ied)|forward\w*|exfiltrat\w*|tokens?|passwords?|secrets?|credentials?|api keys?|ssh|curl|wget)\b|\b(send|upload|post|run|execute|install|delete|copy|forward|exfiltrate)\b[^.\n]{0,80}\b(do not|don't|never)\s+(tell|inform|notify|alert)\s+(the\s+)?(user|human|operator)\b|\bwithout (telling|informing|notifying|asking|alerting) the (user|human)\b|\b(secretly|covertly)\b[^.\n]{0,40}\b(run|execute|send|upload|post|install|delete|copy|exfiltrate|forward)\b|\bhide (this|it|the \w+) from the (user|human)\b/i,
    severity: { instructions: "high", config: "high", script: "medium" },
  },
  {
    id: "persona-override",
    category: "prompt-injection",
    pattern: /\byou are now (a|an|in)\b|\bnew system prompt\b|\b(enter|enable|activate)\s+(developer|god|jailbreak|dan)\s+mode\b|<\/?(system|im_start|im_end)>/i,
    severity: { instructions: "high", config: "high" },
  },
  {
    id: "disable-safety",
    category: "prompt-injection",
    pattern: /\b(override|bypass|disable|turn off|ignore)\b[^.\n]{0,30}\b(safety|security|permission|guardrails?|restrictions|hooks?|sandbox)\b/i,
    // Mostly prose in safety policies ("never bypass safety barriers"): a weak signal on its own.
    severity: { instructions: "low", config: "medium" },
  },
  {
    // Telling the agent to run itself without permission checks is a concrete instruction, not prose.
    id: "skip-permissions-flag",
    category: "prompt-injection",
    pattern: /--dangerously-skip-permissions|--dangerously-bypass-(approvals|hook-trust)[\w-]*|--yolo\b/i,
    severity: { instructions: "medium", config: "medium", script: "medium" },
  },
  {
    id: "hidden-instructions-comment",
    category: "hidden-text",
    pattern: /<!--(?:(?!-->)[\s\S]){0,800}?\b(ignore (all|previous)|you must|do not tell|execute|run the following|curl\s|wget\s|system prompt|assistant:)(?:(?!-->)[\s\S]){0,800}?-->/i,
    severity: { instructions: "high" },
  },
  {
    // Unicode "tag" characters render as nothing but are read by models: a known injection carrier.
    id: "invisible-tag-characters",
    category: "hidden-text",
    pattern: /[\u{E0000}-\u{E007F}]/u,
    severity: ALL("high"),
  },
  {
    id: "zero-width-or-bidi",
    category: "hidden-text",
    pattern: /[\u200B-\u200D\u2060-\u2064\u202A-\u202E\u2066-\u2069]{2,}|[\u202A-\u202E\u2066-\u2069]/,
    severity: { instructions: "medium", config: "medium", script: "medium" },
  },

  // --- execution ---
  {
    id: "download-piped-to-shell",
    category: "remote-exec",
    pattern: /\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\b[^|\n]{0,200}\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|perl|ruby|iex|invoke-expression|pwsh|powershell)\b|<\(\s*(curl|wget)\b|\beval\s*["'(]?\s*\$\(\s*(curl|wget)\b/i,
    // Common in install instructions, so Markdown only warns; in code that runs it is high.
    severity: { instructions: "medium", script: "high", config: "high" },
  },
  {
    id: "encoded-execution",
    category: "obfuscation",
    pattern: /base64\s+(-d|--decode|-D)\b[^\n]{0,60}\|\s*(sudo\s+)?(sh|bash|zsh|python3?|node|perl)\b|frombase64string[\s\S]{0,120}\b(iex|invoke-expression)\b|\s-e(nc|ncodedcommand)\s+[A-Za-z0-9+/=]{24,}|\b(exec|eval)\s*\(\s*(base64\.b64decode|b64decode|atob|Buffer\.from)\s*\(|\bexec\s*\(\s*compile\s*\(/i,
    severity: ALL("high"),
  },
  {
    id: "obfuscated-blob",
    category: "obfuscation",
    pattern: /[A-Za-z0-9+/]{400,}={0,2}|(?:\\x[0-9a-fA-F]{2}){40,}/,
    severity: { script: "medium", config: "medium" },
  },
  {
    id: "persistence",
    category: "persistence",
    pattern: />>?\s*["']?(~|\$HOME|\$\{HOME\})\/\.(bashrc|zshrc|bash_profile|zprofile|profile)\b|\bcrontab\s+(-e|-|[^\s-]\S*)|\bschtasks(\.exe)?\s+\/create\b|\blaunchctl\s+(load|bootstrap)\b|CurrentVersion\\+Run\b|\/etc\/(cron\.|crontab)|\bsystemctl\s+enable\b/i,
    severity: { instructions: "medium", script: "high", config: "high" },
  },
  {
    id: "destructive-delete",
    category: "destructive",
    pattern: /\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+(-[a-zA-Z]+\s+)*["']?(\/|~\/?|\$HOME\/?|\$\{HOME\}\/?)["']?(\*|\s|$)|\bRemove-Item\b[^\n]{0,60}-Recurse[^\n]{0,60}(C:\\\s|\$env:USERPROFILE\b|~\s)|\bformat\s+[a-z]:/i,
    severity: ALL("high"),
  },

  // --- exfiltration: secret access and sending data out; the combination is what matters ---
  {
    id: "reads-secrets",
    category: "secret-access",
    pattern: /(~|\$HOME|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE|homedir\(\)|expanduser\(["']~)[^\n]{0,12}[\\/]?\.(ssh|aws|gnupg|kube|docker|netrc|npmrc|git-credentials)\b|\.claude[\\/]\.credentials|\bid_(rsa|ed25519|ecdsa)\b(?!\.pub)|\bsecurity\s+find-(generic|internet)-password\b|\bLogin\.keychain|\bwallet\.dat\b|Local State["']?[^\n]{0,40}(encrypted_key|os_crypt)|\bprintenv\b|\benv\s*\|/i,
    severity: { instructions: "low", script: "low", config: "low" },
  },
  {
    id: "sends-data",
    category: "network-send",
    pattern: /\b(curl|wget)\b[^\n]*\s(-d|--data[\w-]*|-F|--form|-T|--upload-file|--post-(data|file))\b|\bInvoke-(WebRequest|RestMethod)\b[^\n]*-Method\s+["']?Post|\brequests\.(post|put)\(|\bfetch\([^)]{0,200}method:\s*["'](POST|PUT)|\baxios\.(post|put)\(|\bnc\s+(-\w+\s+)*\S+\s+\d{2,5}\b|\/dev\/tcp\//i,
    severity: { instructions: "low", script: "low", config: "low" },
  },
  {
    id: "exfiltration-endpoint",
    category: "network-send",
    pattern: /discord(app)?\.com\/api\/webhooks|hooks\.slack\.com\/services|api\.telegram\.org\/bot|webhook\.site|requestbin|pipedream\.net|ngrok(-free)?\.(io|app|dev)|transfer\.sh|pastebin\.com|interact\.sh|\.oast\.(fun|pro|live|site|online|me)|burpcollaborator|\bhttps?:\/\/(?!127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d{1,3}(\.\d{1,3}){3}(:\d+)?\//i,
    // Docs mention ngrok or webhooks for legitimate setups; in code that runs it is worth a warning.
    severity: { instructions: "low", script: "medium", config: "medium" },
  },
];

/** Escalation applied per file: reading secrets and sending data in the same file looks like exfiltration. */
export const EXFIL_COMBO: { needs: string[][]; id: string; severity: Partial<Record<Context, Severity>> } = {
  needs: [["reads-secrets"], ["sends-data", "exfiltration-endpoint"]],
  id: "secrets-plus-network",
  severity: { instructions: "high", script: "critical", config: "critical" },
};

/** Rules whose match inside a script comment is ignored (prose, not behavior). */
export const IGNORE_IN_COMMENTS = new Set<Category>(["prompt-injection", "secret-access", "network-send"]);
export const COMMENT_LINE = /^\s*(#|\/\/|\/?\*|--|;|REM\b|<!--)/i;

/**
 * Prompt-injection phrases quoted or discussed (security guidance, examples of attacks) are not
 * attacks themselves: such matches are downgraded to "low".
 */
export const DISCUSSION_CONTEXT = /inject|untrusted|attack|malicious|adversar|phishing|jailbreak|e\.g\.|for example|such as|phrases? like|watch (out )?for|never follow|do not follow|don't follow|refuse|red flag|suspicious|treat (it|them|this) as|\bas data\b|not (as )?instructions|never instructions|instruction-like/i;
export const QUOTE_BEFORE = /["“„«'‘\`]\s*$/;

/** Lines within which secret access and a network send count as one exfiltration pattern. */
export const COMBO_WINDOW_LINES = 20;
