import { describe, expect, it } from "vitest";
import {
  classifyEmail, EmailAuthError, employerDomains, exchangeGmailCode, gmailAuthUrl, gmailQuery, GMAIL_SCOPE, GmailReader, newOAuthAttempt, SecretValue,
  senderDomain, stageFor, suggestFromEmail, type TrackedForEmail,
} from "../src";

const client = { clientId: "cid", clientSecret: "csecret", redirectUri: "https://tc.example.ts.net/settings/email/callback" };
const msg = (from: string, subject: string, snippet = "", at = "2026-11-12T09:00:00Z") => ({ id: "m1", from, subject, snippet, receivedAt: new Date(at) });
const app = (over: Partial<TrackedForEmail>): TrackedForEmail => ({
  id: "a1", employer: "Contoso", title: "Operations Analyst", stage: "applied", createdAt: new Date("2026-11-01T00:00:00Z"), domains: ["contoso.com"], ...over,
});

describe("what kind of message it is (rules only, nothing sent to an AI service)", () => {
  it.each([
    ["Thank you for applying to Contoso", "", "acknowledgement"],
    ["Your application", "We've received your application for Operations Analyst.", "acknowledgement"],
    ["Interview invitation: Operations Analyst", "", "interview"],
    ["Next steps", "Could you share your availability for a 30 minute phone screen?", "interview"],
    ["Your application to Contoso", "Thank you for applying. Unfortunately we have decided to move forward with other candidates.", "rejection"],
    ["Offer letter", "We are pleased to offer you the role, following your interview.", "offer"],
    ["Contoso newsletter", "Read about our latest products", null],
  ])("%s → %s", (subject, snippet, kind) => {
    expect(classifyEmail({ subject, snippet })).toBe(kind);
  });
});

describe("matching a message to one application", () => {
  it("by the employer's own domain", () => {
    const s = suggestFromEmail(msg("Talent Team <jobs@mail.contoso.com>", "Interview invitation"), [app({})])!;
    expect(s).toMatchObject({ applicationId: "a1", kind: "interview", stage: "interview", senderDomain: "mail.contoso.com" });
  });

  it("by the employer's name when the mail comes from a hiring system", () => {
    const s = suggestFromEmail(msg("Contoso Hiring <no-reply@greenhouse.io>", "Unfortunately…", "we will not be moving forward"), [app({})]);
    expect(s).toMatchObject({ kind: "rejection", stage: "closed_lost", senderDomain: "greenhouse.io" });
  });

  it("skips anything unclear rather than guessing", () => {
    const two = [app({ id: "a1", title: "Operations Analyst" }), app({ id: "a2", title: "Planning Lead" })];
    expect(suggestFromEmail(msg("jobs@contoso.com", "Interview invitation"), two)).toBeNull();
    expect(suggestFromEmail(msg("jobs@contoso.com", "Interview invitation: Planning Lead"), two)!.applicationId).toBe("a2");
    expect(suggestFromEmail(msg("Fabrikam <jobs@fabrikam.com>", "Interview invitation"), [app({})])).toBeNull();
    expect(suggestFromEmail(msg("jobs@contoso.com", "Interview invitation", "", "2026-10-01T00:00:00Z"), [app({})])).toBeNull(); // before tracking
  });

  it("suggests only a step forward from where the application is", () => {
    expect(stageFor("acknowledgement", "ready_to_apply")).toBe("applied");
    expect(stageFor("acknowledgement", "applied")).toBeNull();
    expect(stageFor("interview", "interview")).toBeNull();
    expect(stageFor("rejection", "closed_lost")).toBeNull();
    expect(stageFor("offer", "interview")).toBe("offer");
  });

  it("job-board and mail-provider hosts never count as the employer's domain", () => {
    expect(employerDomains(["https://boards.greenhouse.io/contoso/jobs/1", "https://careers.contoso.com/jobs/9", "https://www.linkedin.com/jobs/view/1"])).toEqual(["contoso.com"]);
    expect(senderDomain("Leo <leo@Example.COM>")).toBe("example.com");
    expect(senderDomain("not an address")).toBeNull();
  });

  it("searches only recent mail from tracked employers, never sent mail or chats", () => {
    expect(gmailQuery([app({}), app({ employer: "Fabrikam", domains: [] })])).toBe('newer_than:14d -in:sent -in:drafts -in:chats {"Contoso" "Fabrikam" from:contoso.com}');
    expect(gmailQuery([])).toBeNull();
  });
});

describe("Google sign-in, read-only", () => {
  it("asks only for read-only Gmail, with a one-time state and PKCE", () => {
    const a = newOAuthAttempt();
    const u = new URL(gmailAuthUrl(client, a.state, a.challenge));
    expect(u.searchParams.get("scope")).toBe(GMAIL_SCOPE);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("state")).toBe(a.state);
    expect(newOAuthAttempt().state).not.toBe(a.state);
  });

  const tokenFetch = (scope: string) => (async () => new Response(JSON.stringify({ access_token: "at", refresh_token: "rt-SECRET", scope }), { status: 200 })) as typeof fetch;

  it("keeps the token wrapped so it can't leak into logs", async () => {
    const t = await exchangeGmailCode(client, "code", "verifier", tokenFetch(GMAIL_SCOPE));
    expect(t).toBeInstanceOf(SecretValue);
    expect(JSON.stringify({ t })).not.toContain("rt-SECRET");
    expect(t.reveal()).toBe("rt-SECRET");
  });

  it("refuses a sign-in that grants more than read-only", async () => {
    await expect(exchangeGmailCode(client, "code", "v", tokenFetch(`${GMAIL_SCOPE} https://www.googleapis.com/auth/gmail.send`))).rejects.toBeInstanceOf(EmailAuthError);
    await expect(exchangeGmailCode(client, "code", "v", tokenFetch("https://mail.google.com/"))).rejects.toBeInstanceOf(EmailAuthError);
  });

  it("reads headers and the short preview only", async () => {
    const asked: string[] = [];
    const f = (async (url: string) => {
      asked.push(url);
      if (url.startsWith("https://oauth2.googleapis.com/token")) return new Response(JSON.stringify({ access_token: "at" }));
      if (url.includes("/messages?")) return new Response(JSON.stringify({ messages: [{ id: "abc" }] }));
      return new Response(JSON.stringify({ id: "abc", internalDate: "1763000000000", snippet: "We'd like to interview you",
        payload: { headers: [{ name: "From", value: "jobs@contoso.com" }, { name: "Subject", value: "Interview" }] } }));
    }) as typeof fetch;
    const out = await new GmailReader(client, new SecretValue("rt"), f).search("q", 10);
    expect(out).toEqual([{ id: "abc", from: "jobs@contoso.com", subject: "Interview", snippet: "We'd like to interview you", receivedAt: new Date(1763000000000) }]);
    expect(asked[2]).toMatch(/format=metadata&metadataHeaders=From&metadataHeaders=Subject$/);
    expect(asked.some((u) => /format=(full|raw)|attachments/.test(u))).toBe(false);
  });
});
