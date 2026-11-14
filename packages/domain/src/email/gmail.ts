import { createHash, randomBytes } from "node:crypto";
import { SecretValue } from "../secretStore";
import type { MailMessage } from "./classify";

/**
 * Gmail, read-only (decision 13.3). The only permission asked for is gmail.readonly:
 * TC Hunter cannot send, delete or label mail. The long-lived sign-in token is a
 * SecretValue from the moment it arrives and goes straight into the applicant's vault.
 */
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GoogleClient { clientId: string; clientSecret: string; redirectUri: string }

export function googleClientFrom(env: NodeJS.ProcessEnv, origin?: string): GoogleClient | null {
  const id = env.TC_GOOGLE_CLIENT_ID, secret = env.TC_GOOGLE_CLIENT_SECRET, base = origin ?? env.TC_PUBLIC_ORIGIN;
  return id && secret && base ? { clientId: id, clientSecret: secret, redirectUri: `${base.replace(/\/$/, "")}/settings/email/callback` } : null;
}

/** A one-time state and PKCE pair for one connect attempt. */
export function newOAuthAttempt(): { state: string; verifier: string; challenge: string } {
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  return { state, verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function gmailAuthUrl(c: GoogleClient, state: string, challenge: string): string {
  const q = new URLSearchParams({
    client_id: c.clientId, redirect_uri: c.redirectUri, response_type: "code", scope: GMAIL_SCOPE,
    access_type: "offline", prompt: "consent", include_granted_scopes: "false", state, code_challenge: challenge, code_challenge_method: "S256",
  });
  return `${AUTH}?${q}`;
}

export class EmailAuthError extends Error {
  constructor(public reason: "revoked" | "refused" | "unreachable" | "wrong_scope") { super(`email ${reason}`); }
}

type Fetch = typeof fetch;

async function tokenCall(f: Fetch, body: Record<string, string>): Promise<Record<string, unknown>> {
  let r: Response;
  try { r = await f(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body) }); }
  catch { throw new EmailAuthError("unreachable"); }
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new EmailAuthError(j.error === "invalid_grant" ? "revoked" : "refused");
  return j;
}

/** Trades the one-time code for the long-lived token. Refuses anything wider or narrower than read-only. */
export async function exchangeGmailCode(c: GoogleClient, code: string, verifier: string, f: Fetch = fetch): Promise<SecretValue> {
  const j = await tokenCall(f, { client_id: c.clientId, client_secret: c.clientSecret, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: c.redirectUri });
  const scopes = String(j.scope ?? "").split(" ").filter(Boolean);
  if (!scopes.includes(GMAIL_SCOPE) || scopes.some((s) => s.includes("mail.google.com") || /gmail\.(modify|send|compose|insert|labels)/.test(s))) throw new EmailAuthError("wrong_scope");
  if (typeof j.refresh_token !== "string") throw new EmailAuthError("refused");
  return new SecretValue(j.refresh_token);
}

export async function revokeGmail(token: SecretValue, f: Fetch = fetch): Promise<void> {
  try { await f(`${REVOKE}?${new URLSearchParams({ token: token.reveal() })}`, { method: "POST" }); } catch { /* best effort: the token is deleted either way */ }
}

export interface MailReader {
  address(): Promise<string>;
  search(query: string, max: number): Promise<MailMessage[]>;
}

/** Reads message headers and Gmail's short preview only, never full bodies or attachments. */
export class GmailReader implements MailReader {
  #token: SecretValue;
  #access: string | null = null;
  constructor(private c: GoogleClient, token: SecretValue, private f: Fetch = fetch) { this.#token = token; }
  private async access(): Promise<string> {
    if (!this.#access) {
      const j = await tokenCall(this.f, { client_id: this.c.clientId, client_secret: this.c.clientSecret, refresh_token: this.#token.reveal(), grant_type: "refresh_token" });
      this.#access = String(j.access_token ?? "");
    }
    return this.#access;
  }
  private async get(path: string): Promise<any> {
    let r: Response;
    try { r = await this.f(`${API}${path}`, { headers: { Authorization: `Bearer ${await this.access()}` } }); }
    catch { throw new EmailAuthError("unreachable"); }
    if (r.status === 401 || r.status === 403) throw new EmailAuthError("revoked");
    if (!r.ok) throw new EmailAuthError("unreachable");
    return r.json();
  }
  async address(): Promise<string> { return String((await this.get("/profile")).emailAddress ?? ""); }
  async search(query: string, max: number): Promise<MailMessage[]> {
    const list = await this.get(`/messages?${new URLSearchParams({ q: query, maxResults: String(Math.min(max, 100)) })}`);
    const out: MailMessage[] = [];
    for (const { id } of (list.messages ?? []) as Array<{ id: string }>) {
      const m = await this.get(`/messages/${encodeURIComponent(id)}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`);
      const h = (n: string) => String((m.payload?.headers ?? []).find((x: { name: string }) => x.name.toLowerCase() === n)?.value ?? "");
      out.push({ id: String(m.id), from: h("from"), subject: h("subject"), snippet: String(m.snippet ?? ""), receivedAt: new Date(Number(m.internalDate)) });
    }
    return out;
  }
}

/** A link that opens the message in the applicant's own Gmail. */
export const gmailLink = (messageId: string) => `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(messageId)}`;
