import { SecretValue } from "../secretStore";
import { verificationLinkIn } from "../apply";
import { CODE_SENDER_QUERY } from "../apply/securityCode";
import type { MailMessage } from "./classify";
import { EmailAuthError, GmailReader, pickSecurityCode, type GoogleClient, type MailReader } from "./gmail";

/**
 * Gmail with an app password (Yong, 2026-11-15: the Google Cloud setup was "too complicated
 * for a user"). The person makes a 16-letter app password in their Google account and pastes
 * it with their address: no Google Cloud project. TC Hunter talks only to imap.gmail.com and
 * opens the mailbox read-only (EXAMINE), so nothing is marked read, moved, sent or deleted.
 * The address and app password are one SecretValue in the applicant's vault, like the
 * Google sign-in token. Mail is read in memory and dropped, never sent to an AI service.
 */
export const GMAIL_IMAP_HOST = "imap.gmail.com";
export const GMAIL_IMAP_PORT = 993;
const PREFIX = "gmail-app-password:";

/** An app password as Google shows it ("abcd efgh ijkl mnop"), spaces and dashes removed. */
export function cleanAppPassword(raw: string): string | null {
  const p = raw.replace(/[\s-]/g, "").toLowerCase();
  return /^[a-z]{16}$/.test(p) ? p : null;
}

export function cleanGmailAddress(raw: string): string | null {
  const a = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a) && a.length <= 254 ? a : null;
}

export function appPasswordToken(address: string, password: string): SecretValue {
  return new SecretValue(PREFIX + JSON.stringify({ address, password }));
}

export function readAppPasswordToken(token: SecretValue): { address: string; password: string } | null {
  const v = token.reveal();
  if (!v.startsWith(PREFIX)) return null;
  try {
    const j = JSON.parse(v.slice(PREFIX.length));
    return typeof j.address === "string" && typeof j.password === "string" ? { address: j.address, password: j.password } : null;
  } catch { return null; }
}

/** The right reader for what's in the vault: an app password, or a Google sign-in token. */
export interface ImapOptions { proxy?: string; /** Tests only: a stand-in server. */ server?: { host: string; port: number; secure: boolean } }

export function mailReaderFor(token: SecretValue, google: GoogleClient | null, opts: ImapOptions = {}): MailReader {
  const app = readAppPasswordToken(token);
  if (app) return new GmailImapReader(app.address, app.password, opts);
  if (!google) throw new EmailAuthError("refused");
  return new GmailReader(google, token);
}

type Found = { id: string; uid: number; receivedAt: Date; source: Buffer };

/** Gmail's search words work over IMAP too (X-GM-RAW), so the same queries are used as with the Google sign-in. */
export class GmailImapReader implements MailReader {
  #password: string;
  constructor(private user: string, password: string, private opts: ImapOptions = {}) { this.#password = password; }

  private async withMailbox<T>(fn: (client: import("imapflow").ImapFlow) => Promise<T>): Promise<T> {
    const { ImapFlow } = await import("imapflow");
    const client = new ImapFlow({
      host: GMAIL_IMAP_HOST, port: GMAIL_IMAP_PORT, secure: true, ...this.opts.server, logger: false,
      auth: { user: this.user, pass: this.#password },
      ...(this.opts.proxy ? { proxy: this.opts.proxy } : {}),
    });
    client.on("error", () => { /* surfaced by the awaited call below */ });
    try {
      await client.connect();
    } catch (e) {
      throw new EmailAuthError((e as { authenticationFailed?: boolean })?.authenticationFailed ? "revoked" : "unreachable");
    }
    try {
      const boxes = await client.list();
      const all = boxes.find((b) => b.specialUse === "\\All")?.path ?? "INBOX";
      await client.mailboxOpen(all, { readOnly: true });
      return await fn(client);
    } catch (e) {
      if (e instanceof EmailAuthError) throw e;
      throw new EmailAuthError("unreachable");
    } finally {
      await client.logout().catch(() => client.close());
    }
  }

  /** Newest first, at most `max`, each read up to `maxBytes`. */
  private async find(client: import("imapflow").ImapFlow, query: string, max: number, maxBytes: number): Promise<Found[]> {
    const uids = await client.search({ gmailraw: query }, { uid: true });
    if (!uids || !uids.length) return [];
    const pick = uids.slice(-max);
    const out: Found[] = [];
    for await (const m of client.fetch(pick.join(","), { uid: true, emailId: true, internalDate: true, source: { maxLength: maxBytes } }, { uid: true })) {
      if (!m.source) continue;
      // X-GM-MSGID in hex is the id Gmail uses in its own links.
      const id = m.emailId ? BigInt(m.emailId).toString(16) : `uid-${m.uid}`;
      out.push({ id, uid: m.uid, receivedAt: new Date(m.internalDate ?? Date.now()), source: m.source });
    }
    return out.reverse();
  }

  async address(): Promise<string> {
    // Logging in proves the app password works; the address is the one it was made for.
    return this.withMailbox(async () => this.user);
  }

  async search(query: string, max: number): Promise<MailMessage[]> {
    const { simpleParser } = await import("mailparser");
    return this.withMailbox(async (client) => {
      const out: MailMessage[] = [];
      for (const f of await this.find(client, query, Math.min(max, 100), 32_000)) {
        const p = await simpleParser(f.source);
        const snippet = (p.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
        out.push({ id: f.id, from: p.from?.text ?? "", subject: p.subject ?? "", snippet, receivedAt: f.receivedAt });
      }
      return out;
    });
  }

  async alertBodies(query: string, max: number): Promise<Array<{ id: string; receivedAt: Date; text: string; isHtml: boolean }>> {
    if (!/^from:\(jobalerts-noreply@linkedin\.com/.test(query)) throw new Error("full text is only read for LinkedIn job alerts");
    const { simpleParser } = await import("mailparser");
    return this.withMailbox(async (client) => {
      const out: Array<{ id: string; receivedAt: Date; text: string; isHtml: boolean }> = [];
      for (const f of await this.find(client, query, Math.min(max, 50), 2_000_000)) {
        const p = await simpleParser(f.source);
        if (!/@linkedin\.com>?$/i.test((p.from?.text ?? "").trim())) continue;  // only LinkedIn's own mail
        if (p.text) out.push({ id: f.id, receivedAt: f.receivedAt, text: p.text, isHtml: false });
        else if (typeof p.html === "string") out.push({ id: f.id, receivedAt: f.receivedAt, text: p.html, isHtml: true });
      }
      return out;
    });
  }

  async accountLink(tenantHost: string, since: Date, kind: "verify" | "reset" = "verify"): Promise<string | null> {
    const after = Math.floor(since.getTime() / 1000) - 60;
    const { simpleParser } = await import("mailparser");
    return this.withMailbox(async (client) => {
      for (const f of await this.find(client, `from:(myworkday.com OR myworkdayjobs.com OR workday.com) after:${after}`, 10, 2_000_000)) {
        const p = await simpleParser(f.source);
        if (!/@([a-z0-9-]+\.)*(myworkday|myworkdayjobs|workday)\.com>?$/i.test((p.from?.text ?? "").trim())) continue;  // only Workday's own mail
        const body = p.text ?? (typeof p.html === "string" ? p.html : "");
        const link = body ? verificationLinkIn(body, tenantHost, kind) : null;
        if (link) return link;
      }
      return null;
    });
  }

  async securityCode(since: Date, employer: string, length: number | null): Promise<string | null> {
    const after = Math.floor(since.getTime() / 1000) - 60;
    const { simpleParser } = await import("mailparser");
    return this.withMailbox(async (client) => {
      const mails: Array<{ from: string; text: string }> = [];
      for (const f of await this.find(client, `${CODE_SENDER_QUERY} after:${after}`, 5, 2_000_000)) {
        const p = await simpleParser(f.source);
        const text = p.text ?? (typeof p.html === "string" ? p.html : "");
        if (text) mails.push({ from: p.from?.text ?? "", text });
      }
      return pickSecurityCode(mails, employer, length);
    });
  }
}
