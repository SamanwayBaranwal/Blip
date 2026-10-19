import fs from "node:fs";
import path from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";
import { config } from "./config.js";
import { hooks } from "./hooks.js";
import { deleteSecret, readSecretValue, saveSecret } from "./secrets.js";
import { save, state } from "./store.js";

// The agent's own email address (Grok Bot gives each bot one). It's an ordinary mailbox the user makes for Blip
// (a new Gmail, iCloud, Outlook or Fastmail address, with an app password). People can email it: new mail
// becomes a task for its bot. The bot can write back, but every email it sends is a draft the user approves.
// The password lives in the Keychain. Nothing goes through a Blip server.

const PASSWORD = "agent-email-password";
const fake = () => process.env.BLIP_FAKE_EMAIL === "1"; // tests: sent mail is written to a file, nothing goes out

export type EmailSettings = {
  address: string;
  name: string;
  botId?: string; // whose address it is (default: the primary bot)
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  lastUid?: number; // newest message already handled
  lastCheck?: { at: string; ok: boolean; error?: string };
};

const PRESETS: [RegExp, Pick<EmailSettings, "imapHost" | "imapPort" | "smtpHost" | "smtpPort">][] = [
  [/@(gmail|googlemail)\.com$/i, { imapHost: "imap.gmail.com", imapPort: 993, smtpHost: "smtp.gmail.com", smtpPort: 465 }],
  [/@(icloud|me|mac)\.com$/i, { imapHost: "imap.mail.me.com", imapPort: 993, smtpHost: "smtp.mail.me.com", smtpPort: 587 }],
  [/@(outlook|hotmail|live|msn)\.com$/i, { imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp.office365.com", smtpPort: 587 }],
  [/@fastmail\.(com|fm)$/i, { imapHost: "imap.fastmail.com", imapPort: 993, smtpHost: "smtp.fastmail.com", smtpPort: 465 }],
  [/@yahoo\.com$/i, { imapHost: "imap.mail.yahoo.com", imapPort: 993, smtpHost: "smtp.mail.yahoo.com", smtpPort: 465 }],
  [/@zoho\.com$/i, { imapHost: "imap.zoho.com", imapPort: 993, smtpHost: "smtp.zoho.com", smtpPort: 465 }],
];
export const presetFor = (address: string) => PRESETS.find(([re]) => re.test(address))?.[1];

export const emailSettings = () => state.email;
export const agentAddress = () => state.email?.address;

async function password() {
  const p = await readSecretValue(PASSWORD);
  if (!p) throw new Error("The email password isn't in the Keychain any more. Set up the agent email again in Settings.");
  return p;
}

function imap(s: EmailSettings, pass: string) {
  return new ImapFlow({ host: s.imapHost, port: s.imapPort, secure: s.imapPort === 993, auth: { user: s.address, pass }, logger: false, socketTimeout: 60_000 });
}
function smtp(s: EmailSettings, pass: string) {
  return nodemailer.createTransport({ host: s.smtpHost, port: s.smtpPort, secure: s.smtpPort === 465, auth: { user: s.address, pass }, connectionTimeout: 20_000 });
}
const plainError = (e: unknown) => {
  const msg = (e as Error)?.message ?? String(e);
  return /auth|credentials|invalid login|535|AUTHENTICATIONFAILED/i.test(msg)
    ? "The address or app password was refused. Use an app password (not your normal password): Gmail and iCloud make one in the account's security settings."
    : msg.split("\n")[0]!;
};

/** Saves the mailbox, checks it can both receive and send, and starts watching it. */
export async function setupEmail(input: { address: string; password: string; name?: string; botId?: string; imapHost?: string; imapPort?: number; smtpHost?: string; smtpPort?: number }) {
  const address = input.address.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new Error("That isn't an email address.");
  const preset = presetFor(address);
  const s: EmailSettings = {
    address,
    name: input.name?.trim() || "Blip",
    botId: input.botId,
    imapHost: input.imapHost || preset?.imapHost || "",
    imapPort: input.imapPort || preset?.imapPort || 993,
    smtpHost: input.smtpHost || preset?.smtpHost || "",
    smtpPort: input.smtpPort || preset?.smtpPort || 465,
  };
  if (!s.imapHost || !s.smtpHost) throw new Error("Blip doesn't know this provider's servers. Add the IMAP and SMTP server names (from your provider's help page).");
  if (!fake()) {
    const client = imap(s, input.password);
    try {
      await client.connect();
      const box = await client.mailboxOpen("INBOX");
      s.lastUid = Number(box.uidNext) - 1; // mail already there isn't treated as new
    } catch (e) {
      throw new Error(`Couldn't read the mailbox: ${plainError(e)}`);
    } finally {
      await client.logout().catch(() => {});
    }
    await smtp(s, input.password).verify().catch((e) => {
      throw new Error(`Couldn't send from it: ${plainError(e)}`);
    });
  }
  await saveSecret(PASSWORD, input.password, `Password for the agent email ${address}`);
  state.email = { ...s, lastCheck: { at: new Date().toISOString(), ok: true } };
  save();
  return state.email;
}

export async function removeEmail() {
  state.email = undefined;
  save();
  await deleteSecret(PASSWORD).catch(() => {});
}

/** Sends an email from the agent's address. Only ever called after the user approved the draft. */
export async function sendEmail(m: { to: string; subject: string; body: string; inReplyTo?: string }) {
  const s = state.email;
  if (!s) throw new Error("No agent email is set up. The user can add one in Settings → Agent email.");
  const mail = { from: `"${s.name}" <${s.address}>`, to: m.to, subject: m.subject, text: m.body, ...(m.inReplyTo ? { inReplyTo: m.inReplyTo, references: m.inReplyTo } : {}) };
  if (fake()) {
    fs.appendFileSync(path.join(config.dataDir, "fake-outbox.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...mail }) + "\n");
    return { messageId: `<fake-${Date.now()}@blip>` };
  }
  const info = await smtp(s, await password()).sendMail(mail);
  return { messageId: info.messageId };
}

export type InboundEmail = { from: string; to: string; subject: string; date: string; text: string; messageId?: string };

/** Looks for new mail and hands each one to the bot. Runs every 2 minutes while an address is set up. */
export async function checkInbox() {
  const s = state.email;
  if (!s || fake()) return 0;
  let found = 0;
  const client = imap(s, await password());
  try {
    await client.connect();
    const box = await client.mailboxOpen("INBOX");
    const next = Number(box.uidNext);
    const from = (s.lastUid ?? next - 1) + 1;
    if (from < next) {
      const mails: InboundEmail[] = [];
      for await (const msg of client.fetch(`${from}:*`, { uid: true, source: true }, { uid: true })) {
        if (Number(msg.uid) < from || !msg.source) continue;
        const parsed = await simpleParser(msg.source);
        mails.push({
          from: parsed.from?.text ?? "unknown",
          to: Array.isArray(parsed.to) ? parsed.to.map((t) => t.text).join(", ") : parsed.to?.text ?? s.address,
          subject: parsed.subject ?? "(no subject)",
          date: (parsed.date ?? new Date()).toISOString(),
          text: (parsed.text ?? "").slice(0, 8000),
          messageId: parsed.messageId,
        });
        s.lastUid = Math.max(s.lastUid ?? 0, Number(msg.uid));
        if (mails.length >= 10) break; // a flood waits for the next check
      }
      for (const m of mails) if (!m.from.toLowerCase().includes(s.address)) (found++, hooks.emailArrived(m));
    }
    s.lastCheck = { at: new Date().toISOString(), ok: true };
  } catch (e) {
    s.lastCheck = { at: new Date().toISOString(), ok: false, error: plainError(e) };
  } finally {
    await client.logout().catch(() => {});
    save();
  }
  return found;
}

/** Tests only: pretend an email arrived. */
export function fakeInbound(m: InboundEmail) {
  if (!fake()) throw new Error("Only in test mode.");
  hooks.emailArrived(m);
}

setInterval(() => void checkInbox().catch((e) => console.error("Agent email check failed:", e)), 2 * 60_000).unref();
