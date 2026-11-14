import { describe, expect, it } from "vitest";
import { NAV, locate } from "../lib/nav";

const at = (p: string, h = "") => { const r = locate(p, h); return r ? `${r.section.key}:${r.tab?.href}` : "none"; };

describe("app navigation", () => {
  it("puts each page in one section and tab", () => {
    expect(at("/")).toBe("home:/");
    expect(at("/reports/weekly")).toBe("home:/reports/weekly");
    expect(at("/reports")).toBe("applications:/reports");
    expect(at("/profile")).toBe("me:/profile");
    expect(at("/profile/experience")).toBe("me:/profile");
    expect(at("/profile/resumes/abc")).toBe("me:/profile/import");
    expect(at("/profile/review")).toBe("me:/profile/import");
    expect(at("/jobs/J-123")).toBe("jobs:/jobs");
    expect(at("/jobs/paste")).toBe("jobs:/jobs/paste");
    expect(at("/applications/A-1")).toBe("applications:/applications");
    expect(at("/documents/D-1")).toBe("documents:/documents");
  });
  it("follows the #hash on the settings page", () => {
    expect(at("/settings")).toBe("settings:/settings#security");
    expect(at("/settings", "#email")).toBe("settings:/settings#email");
    expect(at("/settings", "#nope")).toBe("settings:/settings#security");
  });
  it("leaves sign-in pages out", () => {
    expect(at("/sign-in")).toBe("none");
    expect(at("/setup-two-step")).toBe("none");
  });
  it("has the six sections Yong asked for", () => {
    expect(NAV.map((s) => s.label)).toEqual(["Home", "Me", "Jobs", "Applications", "Documents", "Settings"]);
  });
});
