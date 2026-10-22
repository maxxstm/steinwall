// Transactional email through Resend: license keys, resent keys, cancellation confirmations and
// notices to the owner. Plain text first (the license key must survive any mail client), with a
// minimal HTML copy of the same text.

export type Lang = "de" | "en";

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

export interface MailEnv {
  RESEND_API_KEY: string;
  OWNER_EMAIL?: string;
}

const FROM = "SteinWall <license@steinwall.dev>";
const SITE = "https://steinwall.dev";

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export async function sendEmail(env: MailEnv, mail: Mail): Promise<void> {
  const html = `<div style="font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;white-space:pre-wrap;word-break:break-all">${escapeHtml(mail.text)}</div>`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [mail.to], reply_to: env.OWNER_EMAIL || undefined, subject: mail.subject, text: mail.text, html }),
  });
  if (!res.ok) throw new Error(`resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** German for customers in DACH, English for everyone else. */
export function langFor(country: string | null | undefined): Lang {
  return ["DE", "AT", "CH", "LI"].includes((country ?? "").toUpperCase()) ? "de" : "en";
}

const activation = (token: string) => [`  /steinwall:license activate ${token}`, "", `  node ~/.steinwall/bin/steinwall.mjs license activate ${token}`].join("\n");

const footer = (lang: Lang) =>
  lang === "de"
    ? `Verwalten (Zahlungsmittel, Rechnungen): ${SITE}/manage.html\nKündigen: ${SITE}/kuendigen.html\nFragen: Antworte einfach auf diese E-Mail.`
    : `Manage (payment method, invoices): ${SITE}/manage.html\nCancel: ${SITE}/kuendigen.html\nQuestions: just reply to this email.`;

export function licenseMail(lang: Lang, to: string, token: string, referralCode: string): Mail {
  const ref = `${SITE}/?ref=${referralCode}`;
  return lang === "de"
    ? {
        to,
        subject: "Dein SteinWall-Pro-Lizenzschlüssel",
        text: `Danke für deinen Kauf von SteinWall Pro!\n\nAktiviere Pro in Claude Code (erste Zeile) oder in jedem Terminal, auch für Codex (zweite Zeile):\n\n${activation(token)}\n\nDein Empfehlungslink – für jeden neuen Pro-Nutzer darüber bekommst du einen Monat geschenkt:\n${ref}\n\nBewahre den Schlüssel privat auf. Er wird offline geprüft und alle paar Tage erneuert; dabei wird nur der Schlüssel selbst gesendet.\n\n${footer(lang)}`,
      }
    : {
        to,
        subject: "Your SteinWall Pro license key",
        text: `Thank you for buying SteinWall Pro!\n\nActivate Pro in Claude Code (first line) or in any terminal, also for Codex (second line):\n\n${activation(token)}\n\nYour referral link – you get one free month for every new Pro user who signs up through it:\n${ref}\n\nKeep your key private. It is checked offline and refreshed every few days, which only sends the key itself.\n\n${footer(lang)}`,
      };
}

export function resendMail(lang: Lang, to: string, tokens: string[]): Mail {
  const keys = tokens.map(activation).join("\n\n---\n\n");
  return lang === "de"
    ? { to, subject: "Dein SteinWall-Pro-Lizenzschlüssel (erneut gesendet)", text: `Du hast deinen Lizenzschlüssel angefordert:\n\n${keys}\n\nWenn du das nicht warst, kannst du diese E-Mail ignorieren.\n\n${footer(lang)}` }
    : { to, subject: "Your SteinWall Pro license key (sent again)", text: `You asked for your license key:\n\n${keys}\n\nIf this was not you, you can ignore this email.\n\n${footer(lang)}` };
}

export interface CancelledContract {
  plan: string;
  endsAt: string;
}

/** Confirmation in text form of a cancellation received through the cancel button (§ 312k BGB). */
export function cancellationMail(lang: Lang, to: string, receivedAt: Date, kind: "ordinary" | "extraordinary", contracts: CancelledContract[], reason?: string): Mail {
  const when = receivedAt.toLocaleString(lang === "de" ? "de-DE" : "en-GB", { timeZone: "Europe/Berlin", dateStyle: "long", timeStyle: "short" });
  const date = (iso: string) => new Date(iso).toLocaleDateString(lang === "de" ? "de-DE" : "en-GB", { timeZone: "Europe/Berlin", dateStyle: "long" });
  if (lang === "de") {
    const list = contracts.length
      ? contracts.map((c) => `- SteinWall Pro (${c.plan}): endet zum ${date(c.endsAt)}. Bis dahin bleibt Pro aktiv; es wird nichts mehr abgebucht.`).join("\n")
      : "- Zu dieser E-Mail-Adresse haben wir kein aktives Abo gefunden. Wir prüfen deine Kündigung von Hand und melden uns.";
    return {
      to,
      subject: "Bestätigung deiner Kündigung – SteinWall Pro",
      text: `Wir haben deine Kündigung erhalten.\n\nEingang: ${when} (Europe/Berlin)\nE-Mail: ${to}\nArt: ${kind === "ordinary" ? "ordentliche Kündigung zum nächstmöglichen Zeitpunkt" : "außerordentliche Kündigung"}${reason ? `\nGrund: ${reason}` : ""}\n\n${list}${kind === "extraordinary" ? "\n\nDie außerordentliche Kündigung prüfen wir gesondert und melden uns." : ""}\n\nFragen: Antworte einfach auf diese E-Mail.`,
    };
  }
  const list = contracts.length
    ? contracts.map((c) => `- SteinWall Pro (${c.plan}): ends on ${date(c.endsAt)}. Pro stays active until then; you will not be charged again.`).join("\n")
    : "- We found no active subscription for this email address. We will check your cancellation by hand and get back to you.";
  return {
    to,
    subject: "Your cancellation is confirmed – SteinWall Pro",
    text: `We have received your cancellation.\n\nReceived: ${when} (Europe/Berlin)\nEmail: ${to}\nType: ${kind === "ordinary" ? "ordinary cancellation at the next possible date" : "extraordinary cancellation"}${reason ? `\nReason: ${reason}` : ""}\n\n${list}${kind === "extraordinary" ? "\n\nWe will review the extraordinary cancellation separately and get back to you." : ""}\n\nQuestions: just reply to this email.`,
  };
}

export function ownerMail(owner: string, subject: string, text: string): Mail {
  return { to: owner, subject: `[SteinWall] ${subject}`, text };
}
