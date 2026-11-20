import { describe, expect, it } from "vitest";
import { detectSource, parseSourceList } from "../src";

describe("parseSourceList (many companies at once, Yong 2026-11-20)", () => {
  it("reads a name and address per line, in either order and with any separator", () => {
    const { items, bad } = parseSourceList([
      "Medtronic, https://medtronic.wd1.myworkdayjobs.com/MedtronicCareers",
      "https://jj.wd5.myworkdayjobs.com/JJ | Johnson & Johnson",
      "  - BD - https://bdx.wd1.myworkdayjobs.com/EXTERNAL_CAREER_SITE_USA  ",
      "https://abbott.wd5.myworkdayjobs.com/abbottcareers",
      "",
      "# a note",
      "Pfizer (no address yet)",
      "Medtronic, https://medtronic.wd1.myworkdayjobs.com/MedtronicCareers",
    ].join("\n"));
    expect(items).toEqual([
      { name: "Medtronic", url: "https://medtronic.wd1.myworkdayjobs.com/MedtronicCareers" },
      { name: "Johnson & Johnson", url: "https://jj.wd5.myworkdayjobs.com/JJ" },
      { name: "BD", url: "https://bdx.wd1.myworkdayjobs.com/EXTERNAL_CAREER_SITE_USA" },
      { url: "https://abbott.wd5.myworkdayjobs.com/abbottcareers" },
    ]);
    expect(bad).toEqual(["Pfizer (no address yet)"]);
  });

  it("gives addresses detectSource follows as Workday boards", () => {
    const { items } = parseSourceList("Medtronic, https://medtronic.wd1.myworkdayjobs.com/MedtronicCareers.");
    expect(detectSource(items[0]!.url, items[0]!.name)).toMatchObject({ kind: "workday", name: "Medtronic", url: "https://medtronic.wd1.myworkdayjobs.com/MedtronicCareers" });
  });
});
