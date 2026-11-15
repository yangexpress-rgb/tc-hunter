import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  appPasswordToken, cleanAppPassword, cleanGmailAddress, EmailAuthError, GmailImapReader, GmailReader, mailReaderFor, readAppPasswordToken, SecretValue,
} from "../src";

/**
 * A stand-in for Gmail's mail server: just enough IMAP for TC Hunter's reader, and it
 * records every command so the test can prove the mailbox is only ever opened read-only.
 */
const MAILS = [
  { uid: 7, msgid: "1781234567890123456", date: "14-Nov-2026 10:00:00 +0000",
    raw: "From: Acme Recruiting <jobs@acme.example>\r\nSubject: Interview invitation\r\nContent-Type: text/plain\r\n\r\nWe would like to invite you to an interview next week.\r\n" },
  { uid: 9, msgid: "1781234567890999999", date: "15-Nov-2026 09:00:00 +0000",
    raw: "From: Workday <noreply@acme.myworkdayjobs.com>\r\nSubject: Verify your account\r\nContent-Type: text/plain\r\n\r\nVerify: https://acme.wd1.myworkdayjobs.com/en-US/careers/activate/abc123 \r\n" },
];
const commands: string[] = [];
let server: net.Server;
let port = 0;

beforeAll(async () => {
  server = net.createServer((sock) => {
    sock.write("* OK [CAPABILITY IMAP4rev1 AUTH=PLAIN X-GM-EXT-1] ready\r\n");
    let buf = "";
    let authTag: string | null = null;
    const loggedIn = (tag: string, pass: string) => sock.write(pass === "abcdefghijklmnop"
      ? `${tag} OK [CAPABILITY IMAP4rev1 X-GM-EXT-1 SPECIAL-USE] logged in\r\n`
      : `${tag} NO [AUTHENTICATIONFAILED] Invalid credentials (Failure)\r\n`);
    sock.on("data", (d) => {
      buf += d.toString("utf8");
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (authTag) { const tag = authTag; authTag = null; loggedIn(tag, Buffer.from(line, "base64").toString("utf8").split("\0")[2] ?? ""); continue; }
        const [tag, cmd0, ...rest] = line.split(" ");
        const cmd = (cmd0 ?? "").toUpperCase();
        const args = rest.join(" ");
        commands.push(cmd === "LOGIN" || cmd === "AUTHENTICATE" ? cmd : `${cmd} ${args}`.trim());
        const ok = (t = "done") => sock.write(`${tag} OK ${t}\r\n`);
        if (cmd === "CAPABILITY") { sock.write("* CAPABILITY IMAP4rev1 AUTH=PLAIN X-GM-EXT-1\r\n"); ok(); }
        else if (cmd === "LOGIN") loggedIn(tag!, args.includes("abcdefghijklmnop") ? "abcdefghijklmnop" : "wrong");
        else if (cmd === "AUTHENTICATE") {
          const inline = rest[1];
          if (inline) loggedIn(tag!, Buffer.from(inline, "base64").toString("utf8").split("\0")[2] ?? "");
          else { authTag = tag!; sock.write("+ \r\n"); }
        }
        else if (cmd === "ID" || cmd === "NOOP" || cmd === "ENABLE") ok();
        else if (cmd === "NAMESPACE") { sock.write('* NAMESPACE (("" "/")) NIL NIL\r\n'); ok(); }
        else if (cmd === "LIST" || cmd === "XLIST") {
          if (args.includes('""') && args.endsWith('""')) sock.write('* LIST (\\Noselect) "/" ""\r\n');
          else { sock.write('* LIST (\\HasNoChildren) "/" "INBOX"\r\n* LIST (\\All \\HasNoChildren) "/" "[Gmail]/All Mail"\r\n'); }
          ok();
        }
        else if (cmd === "LSUB") ok();
        else if (cmd === "EXAMINE") { sock.write("* 2 EXISTS\r\n* OK [UIDVALIDITY 1] ok\r\n* OK [UIDNEXT 10] ok\r\n"); sock.write(`${tag} OK [READ-ONLY] examined\r\n`); }
        else if (cmd === "SELECT") { sock.write(`${tag} NO not allowed in this test\r\n`); }
        else if (cmd === "UID" && /^SEARCH/i.test(args)) {
          const workday = /myworkday/i.test(args);
          sock.write(`* SEARCH ${workday ? "9" : "7 9"}\r\n`); ok();
        }
        else if (cmd === "UID" && /^FETCH/i.test(args)) {
          const want = args.split(" ")[1]!.split(",").map(Number);
          for (const [n, m] of MAILS.entries()) {
            if (!want.includes(m.uid)) continue;
            const body = Buffer.from(m.raw);
            sock.write(`* ${n + 1} FETCH (UID ${m.uid} X-GM-MSGID ${m.msgid} INTERNALDATE "${m.date}" BODY[] {${body.length}}\r\n`);
            sock.write(body); sock.write(")\r\n");
          }
          ok();
        }
        else if (cmd === "LOGOUT") { sock.write("* BYE\r\n"); ok(); sock.end(); }
        else ok();
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as net.AddressInfo).port;
});
afterAll(() => { server.close(); });

const reader = (pass = "abcdefghijklmnop") => new GmailImapReader("yong.test@gmail.com", pass, { server: { host: "127.0.0.1", port, secure: false } });

describe("Gmail with an app password (Yong, 2026-11-15: simpler than Google Cloud)", () => {
  it("accepts the code the way Google shows it, and keeps it in one vault secret", () => {
    expect(cleanAppPassword("abcd efgh ijkl mnop")).toBe("abcdefghijklmnop");
    expect(cleanAppPassword("ABCD-EFGH-IJKL-MNOP")).toBe("abcdefghijklmnop");
    expect(cleanAppPassword("Password123!")).toBeNull();
    expect(cleanGmailAddress("  Yong.Test@Gmail.com ")).toBe("yong.test@gmail.com");
    expect(cleanGmailAddress("not an address")).toBeNull();
    const t = appPasswordToken("yong.test@gmail.com", "abcdefghijklmnop");
    expect(String(t)).not.toContain("abcdefghijklmnop");
    expect(readAppPasswordToken(t)).toEqual({ address: "yong.test@gmail.com", password: "abcdefghijklmnop" });
    expect(readAppPasswordToken(new SecretValue("1//google-refresh-token"))).toBeNull();
  });

  it("picks the right reader for what's in the vault", () => {
    expect(mailReaderFor(appPasswordToken("a@gmail.com", "abcdefghijklmnop"), null)).toBeInstanceOf(GmailImapReader);
    expect(mailReaderFor(new SecretValue("1//x"), { clientId: "c", clientSecret: "s", redirectUri: "https://x/cb" })).toBeInstanceOf(GmailReader);
    expect(() => mailReaderFor(new SecretValue("1//x"), null)).toThrow(EmailAuthError);
  });

  it("a wrong code reads as 'connect again', and nothing else is tried", async () => {
    await expect(reader("zzzzzzzzzzzzzzzz").address()).rejects.toMatchObject({ reason: "revoked" });
  });

  it("finds mail with Gmail's own search words, opening the mailbox read-only", async () => {
    commands.length = 0;
    const found = await reader().search("newer_than:14d (acme)", 50);
    expect(found.map((m) => m.subject)).toEqual(["Verify your account", "Interview invitation"]);  // newest first
    expect(found[1]).toMatchObject({ from: expect.stringContaining("jobs@acme.example"), snippet: expect.stringContaining("invite you to an interview") });
    expect(found[1]!.id).toBe(BigInt("1781234567890123456").toString(16));  // the id Gmail's own links use
    expect(commands.some((c) => c.startsWith('EXAMINE "[Gmail]/All Mail"'))).toBe(true);
    expect(commands.some((c) => /^(SELECT|STORE|COPY|MOVE|EXPUNGE|APPEND|UID (STORE|COPY|MOVE|EXPUNGE))\b/i.test(c))).toBe(false);
    expect(commands.find((c) => /SEARCH/i.test(c))).toMatch(/X-GM-RAW/);
  });

  it("finds the Workday 'verify your account' link for that site", async () => {
    expect(await reader().accountLink("acme.wd1.myworkdayjobs.com", new Date("2026-11-15T08:00:00Z"))).toBe("https://acme.wd1.myworkdayjobs.com/en-US/careers/activate/abc123");
  });
});
