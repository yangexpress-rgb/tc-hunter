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
    expect(at("/profile/goals")).toBe("me:/profile/goals");
    expect(at("/profile/preferences")).toBe("me:/profile/goals");
    expect(at("/jobs/J-123")).toBe("jobs:/jobs");
    expect(at("/jobs/paste")).toBe("jobs:/jobs");  // adding a job lives on Matches now
    expect(at("/applications/A-1")).toBe("applications:/applications");
    expect(at("/documents/D-1")).toBe("documents:/documents");
  });
  it("follows the #hash on the settings page", () => {
    expect(at("/settings")).toBe("settings:/settings#security");
    expect(at("/settings", "#email")).toBe("settings:/settings#email");
    expect(at("/settings", "#nope")).toBe("settings:/settings#security");
  });
  it("names the Me tabs as Yong asked: Goals and Initial Input", () => {
    expect(NAV.find((s) => s.key === "me")!.tabs.map((t) => t.label)).toEqual(["About you", "Stories", "Saved answers", "Goals", "Initial Input"]);
  });
  it("leaves sign-in pages out", () => {
    expect(at("/sign-in")).toBe("none");
    expect(at("/setup-two-step")).toBe("none");
  });
  it("has the six sections Yong asked for", () => {
    expect(NAV.map((s) => s.label)).toEqual(["Home", "Me", "Jobs", "Applications", "Documents", "Settings"]);
  });
});
