import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BANNED_LAYER1_WORDS, BRAND, ERROR_MESSAGES, L1, plainError } from "../src";

const WEB_ROOT = join(__dirname, "..", "..", "..", "apps", "web");

function filesUnder(dir: string, exts: string[]): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out = out.concat(filesUnder(p, exts));
    else if (exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

const bannedRe = new RegExp(`\\b(${BANNED_LAYER1_WORDS.join("|")})s?\\b`, "i");

describe("Layer 1 language (brief 2.1)", () => {
  it("no banned technical word appears in any Layer 1 message", () => {
    for (const [key, text] of Object.entries(L1)) expect(text, key).not.toMatch(bannedRe);
  });

  it("no banned word appears as visible text in web pages outside the Advanced layer", () => {
    // Visible JSX text: anything between > and < that is not code. Layer 3 lives under components/advanced.
    const files = filesUnder(join(WEB_ROOT, "app"), [".tsx"]).concat(
      filesUnder(join(WEB_ROOT, "components"), [".tsx"]).filter((f) => !f.includes(`${"/"}advanced${"/"}`)),
    );
    expect(files.length).toBeGreaterThan(3);
    for (const f of files) {
      const text = readFileSync(f, "utf8").match(/>[^<>{}]+</g) ?? [];
      for (const t of text) expect(t, f).not.toMatch(bannedRe);
    }
  });

  it("every error code maps to a plain sentence, and unknown errors still read plainly", () => {
    for (const key of Object.values(ERROR_MESSAGES)) expect(L1[key]).toBeTruthy();
    expect(plainError("Playwright navigation timeout")).toBe(L1["error.generic"]);
    expect(plainError("TC_APPROVAL_STALE")).toBe(L1["error.approval_stale"]);
  });
});

describe("brand rule (brief v1.1)", () => {
  const forbidden = /(tim\s*cook|apple|cupertino|iphone|\bmac\b|\bios\b)/i;
  it("the tagline is the only Tim Cook reference in Layer 1 text", () => {
    expect(BRAND).toEqual({ name: "TC Hunter", tagline: "Get hired. Rise like Tim Cook." });
    for (const [key, text] of Object.entries(L1)) expect(text, key).not.toMatch(forbidden);
  });
  it("web pages show no Tim Cook / Apple reference except through BRAND.tagline", () => {
    const files = filesUnder(WEB_ROOT, [".tsx", ".ts", ".css", ".svg", ".json"]).filter((f) => !f.endsWith("next-env.d.ts"));
    for (const f of files) expect(readFileSync(f, "utf8"), f).not.toMatch(forbidden);
  });
});
