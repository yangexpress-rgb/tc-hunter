import { inspect } from "node:util";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditPayload, AUDIT_ALLOWED_KEYS, createLogger, FileSecretStore, MemorySecretStore, redact, SecretValue,
} from "../src";

describe("SecretValue", () => {
  it("never shows the secret through string, JSON or inspect", () => {
    const s = new SecretValue("hunter2-canary");
    expect(String(s)).toBe("[secret]");
    expect(JSON.stringify({ s })).toBe('{"s":"[secret]"}');
    expect(inspect({ s })).not.toContain("hunter2");
    expect(`${s}`).toBe("[secret]");
    expect(s.reveal()).toBe("hunter2-canary");
  });
});

describe("vault (brief 2.4)", () => {
  for (const [name, make] of [
    ["memory", () => new MemorySecretStore()],
    ["file", () => new FileSecretStore(mkdtempSync(join(tmpdir(), "v-")), randomBytes(32))],
  ] as const) {
    it(`${name}: returns only an opaque reference; each applicant has their own vault`, async () => {
      const store = make();
      const yong = "11111111-1111-4111-8111-111111111111";
      const leo = "22222222-2222-4222-8222-222222222222";
      const ref = await store.put(yong, "site_password", "jobs.example.test", new SecretValue("pw-canary"));
      expect(ref).toMatch(/^vault:[0-9a-f-]{36}$/);
      expect(ref).not.toContain("pw-canary");
      expect((await store.get(yong, ref))!.reveal()).toBe("pw-canary");
      expect(await store.get(leo, ref)).toBeNull();
      await store.destroyVault(yong);
      expect(await store.get(yong, ref)).toBeNull();
    });
  }

  it("file vault: one applicant's file cannot be opened as the other's", async () => {
    const dir = mkdtempSync(join(tmpdir(), "v-"));
    const store = new FileSecretStore(dir, randomBytes(32));
    const yong = "11111111-1111-4111-8111-111111111111";
    const leo = "22222222-2222-4222-8222-222222222222";
    await store.put(yong, "site_password", "a", new SecretValue("pw-canary"));
    const { renameSync } = await import("node:fs");
    renameSync(join(dir, `${yong}.vault`), join(dir, `${leo}.vault`));
    await expect(store.get(leo, "vault:00000000-0000-4000-8000-000000000000")).rejects.toThrow("vault could not be opened");
    for (const f of readdirSync(dir)) expect(readFileSync(join(dir, f)).toString("latin1")).not.toContain("pw-canary");
  });
});

describe("redaction", () => {
  it("removes secrets and personal data by field name, at any depth", () => {
    const out = redact({
      event: "x", password: "p", nested: { session_cookie: "c", email: "e@x", ok: 1 },
      list: [{ api_key: "k", answer_value: "a" }], legal_name: "N", secret: new SecretValue("s"),
    });
    expect(JSON.stringify(out)).not.toMatch(/"p"|"c"|e@x|"k"|"a"|"N"|"s"/);
    expect((out as { nested: { ok: number } }).nested.ok).toBe(1);
  });
  it("logger output is redacted", () => {
    const lines: string[] = [];
    createLogger((l) => lines.push(l)).info("signed_in", { email: "yong@example.test", token: "t0k", count: 2 });
    expect(lines[0]).not.toContain("yong@example.test");
    expect(lines[0]).not.toContain("t0k");
    expect(lines[0]).toContain('"count":2');
  });
});

describe("audit allow-list (brief 5.6)", () => {
  it("rejects any key not allowed for the action", () => {
    expect(() => auditPayload("packet.submitted", { application_ref: "A-000001", password: "x" })).toThrow(/not allowed/);
    expect(() => auditPayload("mfa.enabled", { email: "x" })).toThrow(/not allowed/);
    expect(auditPayload("site_account.created", { site_host: "a" })).toEqual({ site_host: "a" });
  });
  it("no allowed key could hold a secret or full personal details", () => {
    const bad = /(pass|secret|token|cookie|session|otp|email|phone|name$|address|answer_value)/i;
    for (const keys of Object.values(AUDIT_ALLOWED_KEYS)) for (const k of keys) expect(k).not.toMatch(bad);
  });
});
