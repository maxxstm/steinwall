/**
 * Minimal shell splitter for policy checks (bash and PowerShell). It is deliberately forgiving:
 * it never fails, it only has to find command names and arguments well enough to spot risky ones.
 */
export interface Segment {
  tokens: string[];
  /** True when this command reads the previous one's output through a pipe. */
  piped: boolean;
}

const SHELLS_WITH_INLINE_SCRIPT = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "pwsh", "powershell", "cmd", "eval"]);
const INLINE_FLAGS = new Set(["-c", "-command", "/c", "/k", "-encodedcommand"]);
const HEREDOC_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "source", "."]);
/** Placeholder token for a PowerShell here-string's text. */
const HERE_STRING = "\u0000here-string:";

export function parseShell(command: string, depth = 0): Segment[] {
  const segments: Segment[] = [];
  let tokens: string[] = [];
  let token = "";
  let inToken = false;
  let quote: "'" | '"' | null = null;
  let piped = false;

  const endToken = () => {
    if (inToken) tokens.push(token);
    token = "";
    inToken = false;
  };
  const endSegment = (nextPiped: boolean) => {
    endToken();
    if (tokens.length) segments.push({ tokens, piped });
    tokens = [];
    piped = nextPiped;
  };
  // Heredocs (`cmd <<'EOF' ... EOF`) waiting for their body, which starts after the current line.
  const heredocs: { delim: string; stripTabs: boolean; runsBody: boolean }[] = [];
  const hereStrings: string[] = [];

  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    const next = command[i + 1];
    if (!quote && c === "<" && next === "<" && command[i + 2] !== "<") {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z_][\w.-]*)\2/.exec(command.slice(i));
      if (m) {
        endToken();
        // A heredoc fed to a shell is code that runs; fed to anything else (cat > file) it is data.
        const consumer = commandName(effectiveArgs(tokens)[0] ?? "");
        heredocs.push({ delim: m[3]!, stripTabs: m[1] === "-", runsBody: HEREDOC_SHELLS.has(consumer) });
        i += m[0].length - 1;
        continue;
      }
    }
    if (!quote && c === "\n" && heredocs.length) {
      endSegment(false);
      for (const doc of heredocs.splice(0)) {
        const body: string[] = [];
        let pos = i + 1;
        while (pos <= command.length) {
          const end = command.indexOf("\n", pos);
          const line = command.slice(pos, end < 0 ? undefined : end);
          pos = end < 0 ? command.length + 1 : end + 1;
          if ((doc.stripTabs ? line.replace(/^\t+/, "") : line).replace(/\r$/, "") === doc.delim) break;
          body.push(line);
        }
        if (doc.runsBody && depth < 3) segments.push(...parseShell(body.join("\n"), depth + 1));
        i = pos - 2; // continue right after the delimiter line
      }
      continue;
    }
    // PowerShell here-string (`@'` or `@"` at the end of a line, closed by `'@` / `"@` at the start of
    // one). Its text is data, e.g. a script piped into `node -`, unless it is piped into a shell.
    if (!quote && c === "@" && (next === "'" || next === '"') && /^\r?\n/.test(command.slice(i + 2))) {
      const close = new RegExp(`\\r?\\n${next}@`).exec(command.slice(i + 2));
      if (close) {
        endToken();
        hereStrings.push(command.slice(i + 2, i + 2 + close.index).replace(/^\r?\n/, ""));
        tokens.push(`${HERE_STRING}${hereStrings.length - 1}`);
        i += 2 + close.index + close[0].length - 1;
        continue;
      }
    }
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === "\\" && (next === '"' || next === "\\")) token += command[++i];
      else token += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inToken = true;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      endToken();
    } else if (c === "\n" || c === ";" || c === "(" || c === ")" || c === "`" || c === "{" || c === "}") {
      endSegment(false);
    } else if (c === "|") {
      if (next === "|") i++;
      endSegment(next !== "|");
    } else if (c === "&") {
      if (command[i - 1] === ">" || next === ">") {
        token += c; // 2>&1, &>
        inToken = true;
      } else {
        if (next === "&") i++;
        endSegment(false);
      }
    } else if ((c === ">" || c === "<") && !inToken) {
      tokens.push(c);
    } else if (c === ">" || c === "<") {
      endToken();
      tokens.push(c);
    } else {
      token += c;
      inToken = true;
    }
  }
  endSegment(false);

  // A here-string piped into a shell (`@'...'@ | pwsh -`, `| iex`) is code after all.
  if (depth < 3 && hereStrings.length) {
    for (const [k, seg] of segments.entries()) {
      const name = commandName(seg.tokens[0] ?? "");
      if (!seg.piped || !(SHELLS_WITH_INLINE_SCRIPT.has(name) || name === "iex" || name === "invoke-expression")) continue;
      for (const t of segments[k - 1]?.tokens ?? []) {
        if (t.startsWith(HERE_STRING)) segments.push(...parseShell(hereStrings[Number(t.slice(HERE_STRING.length))] ?? "", depth + 1));
      }
    }
  }

  // Look inside `bash -c "..."`, `pwsh -Command "..."`, `eval "..."`.
  if (depth < 3) {
    for (const seg of [...segments]) {
      const name = commandName(seg.tokens[0] ?? "");
      if (!SHELLS_WITH_INLINE_SCRIPT.has(name)) continue;
      const idx = name === "eval" ? 0 : seg.tokens.findIndex((t) => INLINE_FLAGS.has(t.toLowerCase()));
      const script = idx >= 0 ? seg.tokens.slice(idx + 1).join(" ") : "";
      if (script) segments.push(...parseShell(script, depth + 1));
    }
  }
  return segments;
}

/** "/usr/bin/RM.exe" -> "rm" */
export function commandName(token: string): string {
  const base = token.replace(/\\/g, "/").split("/").pop() ?? "";
  return base.toLowerCase().replace(/\.exe$/, "");
}

const WRAPPERS = new Set(["sudo", "doas", "command", "builtin", "exec", "nohup", "time", "nice", "env", "xargs", "call", "&", "."]);
const SUDO_FLAGS_WITH_VALUE = new Set(["-u", "-g", "-h", "-p", "-c", "-d", "-r", "-t", "-U", "-C", "-D"]);

/** Strip `sudo`, `env X=1`, `xargs -0` etc. so args[0] is the real command. */
export function effectiveArgs(tokens: string[]): string[] {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    const name = commandName(t);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
    } else if (WRAPPERS.has(name)) {
      i++;
      while (i < tokens.length && tokens[i]!.startsWith("-")) {
        i += (name === "sudo" || name === "doas") && SUDO_FLAGS_WITH_VALUE.has(tokens[i]!) ? 2 : 1;
      }
    } else {
      break;
    }
  }
  return tokens.slice(i);
}
