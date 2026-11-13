import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalJson, decryptField, encryptField, newWrappedDataKey, packetFingerprint, totpAt, unwrapDataKey, verifyTotp,
  base32Encode, hashPassword, verifyPassword, passwordProblem,
} from "../src";

describe("field encryption", () => {
  const master = randomBytes(32);
  it("each applicant has their own data key", () => {
    const yongKey = unwrapDataKey(master, newWrappedDataKey(master, "yong"), "yong");
    const leoKey = unwrapDataKey(master, newWrappedDataKey(master, "leo"), "leo");
    const sealed = encryptField(yongKey, "applicant.email", "yong@example.test");
    expect(decryptField(yongKey, "applicant.email", sealed)).toBe("yong@example.test");
    expect(() => decryptField(leoKey, "applicant.email", sealed)).toThrow();
  });
  it("a value cannot be moved to another column", () => {
    const k = randomBytes(32);
    const sealed = encryptField(k, "applicant.phone", "555");
    expect(() => decryptField(k, "applicant.email", sealed)).toThrow();
  });
  it("a wrapped key cannot be unwrapped as another applicant's", () => {
    const w = newWrappedDataKey(master, "yong");
    expect(() => unwrapDataKey(master, w, "leo")).toThrow();
  });
});

describe("packet fingerprint (Risk 4, point 2)", () => {
  const base = {
    jobPostingId: "j1",
    tailoredResume: { id: "d1", contentHash: "c1" },
    fields: [
      { ordinal: 2, question: "Notice period", answer: "Two weeks", source: "answer_bank", requiresApplicantStep: false },
      { ordinal: 1, question: "Name", answer: "Yong", source: "master_profile", requiresApplicantStep: false },
    ],
  };
  it("is stable regardless of key and field order", () => {
    const reordered = { fields: [...base.fields].reverse(), tailoredResume: base.tailoredResume, jobPostingId: "j1" };
    expect(packetFingerprint(reordered)).toBe(packetFingerprint(base));
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });
  it("changes when any answer, document version or job changes", () => {
    const h = packetFingerprint(base);
    expect(packetFingerprint({ ...base, fields: [{ ...base.fields[0]!, answer: "Three weeks" }, base.fields[1]!] })).not.toBe(h);
    expect(packetFingerprint({ ...base, tailoredResume: { id: "d1", contentHash: "c2" } })).not.toBe(h);
    expect(packetFingerprint({ ...base, jobPostingId: "j2" })).not.toBe(h);
  });
  it("does not carry answers in clear", () => {
    expect(packetFingerprint(base)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("two-step codes (RFC 6238)", () => {
  // RFC 6238 appendix B, SHA-1 secret "12345678901234567890", 8 digits truncated to 6.
  const secret = base32Encode(Buffer.from("12345678901234567890"));
  it("matches the RFC test vectors", () => {
    expect(totpAt(secret, 59_000)).toBe("287082");
    expect(totpAt(secret, 1111111109_000)).toBe("081804");
    expect(totpAt(secret, 1234567890_000)).toBe("005924");
  });
  it("accepts one step of clock drift, not more", () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totpAt(secret, now - 30_000), now)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, now - 90_000), now)).toBe(false);
    expect(verifyTotp(secret, "12345", now)).toBe(false);
  });
});

describe("app password", () => {
  it("argon2id round trip", async () => {
    const h = await hashPassword("a long enough passphrase");
    expect(h.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(h, "a long enough passphrase")).toBe(true);
    expect(await verifyPassword(h, "wrong")).toBe(false);
  });
  it("basic strength rules", () => {
    expect(passwordProblem("short", "a@b.c")).toBe("password_too_short");
    expect(passwordProblem("yongyongyong123", "yong@x.test")).toBe("password_contains_email");
    expect(passwordProblem("aaaaaaaaaaaaaaa", "z@x.test")).toBe("password_too_simple");
    expect(passwordProblem("correct horse battery", "z@x.test")).toBeNull();
  });
});
