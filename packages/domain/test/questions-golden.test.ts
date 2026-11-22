import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AiOffError, aiClient, proposeFields, setAiClientsForTest, withAiProvider, type FormField, type PacketProfile } from "../src";

/**
 * The question golden set (Yong, 2026-11-21, §C): question → expected resolution, in No AI mode, from the
 * applicant's own information only. The answer-side analogue of F9: a change that alters a resolution must
 * alter fixtures/questions-golden/cases.json deliberately.
 */
type Expect = { answer: string | null; source?: string; ref?: string; step?: string; parent?: string; note?: string };
type Case = FormField & { expect: Expect };
const G = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "fixtures", "questions-golden", "cases.json"), "utf8")) as {
  profile: PacketProfile; sets: Array<{ name: string; employer: string; standing?: PacketProfile["standing"]; qualifications?: PacketProfile["qualifications"]; fields: Case[] }>;
};

describe("question golden set (No AI)", () => {
  for (const set of G.sets) {
    it(set.name, async () => {
      let calls = 0;
      setAiClientsForTest({ claude: new Proxy({}, { get: () => { calls++; throw new Error("AI called"); } }) as never, openai: new Proxy({}, { get: () => { calls++; throw new Error("AI called"); } }) as never });
      try {
        await withAiProvider("none", async () => {
          const profile: PacketProfile = { ...G.profile, employer: set.employer, standing: set.standing ?? [], qualifications: set.qualifications ?? null };
          const fields = set.fields.map(({ expect: _e, ...f }) => f as FormField);
          const got = proposeFields(fields, profile);
          // Same posting + same profile + same mode ⇒ the same proposals, every time (and whatever order the bank is in).
          expect(proposeFields(fields, { ...profile, answers: [...profile.answers].reverse() })).toEqual(got);
          for (const [i, c] of set.fields.entries()) {
            const g = got[i]!;
            const at = `${set.name} › ${c.key}: ${c.label.slice(0, 60)}`;
            const filled = g.step ? null : g.answer;
            expect(filled, at).toBe(c.expect.answer);
            if (c.expect.source) expect(g.source, at).toBe(c.expect.source);
            if (c.expect.ref) expect(g.sourceRefId, at).toBe(c.expect.ref);
            if (c.expect.step) expect(g.step, at).toBe(c.expect.step);
            if (c.expect.parent) expect(g.parentKey, at).toBe(c.expect.parent);
            if (c.expect.note) expect(g.note, at).toBe(c.expect.note);
            // Every answer carries its source and a note on where it came from, or why it's left.
            if (filled !== null) expect(g.source, at).toBeTruthy();
            else expect(g.note ?? g.step, at).toBeTruthy();
          }
          await expect(aiClient("judgment").beta.messages.parse({} as never)).rejects.toBeInstanceOf(AiOffError);
        });
      } finally { setAiClientsForTest(null); }
      expect(calls).toBe(0);
    });
  }

  it("without 'work history complete', prior employment is asked, never answered No", () => {
    const p: PacketProfile = { ...G.profile, employer: "Capital One", workHistoryComplete: false };
    const [f] = proposeFields([{ key: "c6", label: "Have you ever been employed by Capital One or any of its subsidiaries?*", type: "select", options: ["Yes", "No"] }], p);
    expect(f).toMatchObject({ answer: null, source: null });
    expect(f!.note).toMatch(/work history complete/);
    // A role there is still a Yes, complete or not.
    const [y] = proposeFields([{ key: "x", label: "Have you previously worked for Northwind Traders?", type: "select", options: ["Yes", "No"] }], { ...p, employer: "Northwind Traders Inc." });
    expect(y).toMatchObject({ answer: "Yes", source: "derived", sourceRefId: "e2" });
  });

  it("a parent answered No: its follow-up box isn't needed", () => {
    const p: PacketProfile = { ...G.profile, employer: "Capital One", answers: G.profile.answers.map((a) => (a.id === "a-2nd" ? { ...a, text: "No" } : a)) };
    const out = proposeFields([
      { key: "c7", label: "Do you currently have a second job or other outside employment?*", type: "select", options: ["Yes", "No"], required: true },
      { key: "c8", label: "If yes, please describe the nature of your second job.*", type: "textarea", required: true },
    ], p);
    expect(out[1]).toMatchObject({ answer: null, required: false, parentKey: "c7" });
  });
});
