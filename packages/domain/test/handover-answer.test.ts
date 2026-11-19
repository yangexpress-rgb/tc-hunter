import { describe, expect, it } from "vitest";
import { handoverSentence } from "../src";

describe("\"Your turn\" for an answer their form won't take (Accenture, 2026-11-19)", () => {
  it("names the question and says what to do", () => {
    expect(handoverSentence("answer", "Accenture", ["I accept.*"])).toBe("Accenture's form won't take TC Hunter's answer to \"I accept.\". Put it in yourself on their page, then hand it back.");
    expect(handoverSentence("answer", "Accenture", ["A*", "B*"])).toMatch(/"A" and 1 more/);
  });
});
