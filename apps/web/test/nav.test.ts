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
    expect(at("/documents")).toBe("applications:/documents");
    expect(at("/documents/D-1")).toBe("applications:/documents");
    expect(at("/documents/D-1/pdf")).toBe("applications:/documents");
  });
  it("gives each kind of setting its own page, Email among them", () => {
    expect(NAV.find((s) => s.key === "settings")!.tabs.map((t) => t.label)).toEqual(["Sign-in and security", "Email", "Job sites", "Applying for you", "Your data"]);
    expect(at("/settings")).toBe("settings:/settings");
    expect(at("/settings/email")).toBe("settings:/settings/email");
    expect(at("/settings/email/connect")).toBe("settings:/settings/email");
    expect(at("/settings/job-sites")).toBe("settings:/settings/job-sites");
    expect(at("/settings/applying")).toBe("settings:/settings/applying");
    expect(at("/settings/data")).toBe("settings:/settings/data");
  });
  it("names the Me tabs as Yong asked: Goals and Initial Input", () => {
    expect(NAV.find((s) => s.key === "me")!.tabs.map((t) => t.label)).toEqual(["About you", "Stories", "Saved answers", "Goals", "Initial Input"]);
  });
  it("leaves sign-in pages out", () => {
    expect(at("/sign-in")).toBe("none");
    expect(at("/setup-two-step")).toBe("none");
  });
  it("has the five sections Yong asked for, Documents inside Applications", () => {
    expect(NAV.map((s) => s.label)).toEqual(["Home", "Me", "Jobs", "Applications", "Settings"]);
    expect(NAV.find((s) => s.key === "applications")!.tabs.map((t) => t.label)).toEqual(["Tracker", "Documents", "Reports"]);
  });
});
