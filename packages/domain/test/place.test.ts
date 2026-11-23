import { describe, expect, it } from "vitest";
import { placeVerdict } from "../src";

const job = (locationRaw: string | null, workplaceType: "remote" | "hybrid" | "onsite" | null = null) => ({ locationRaw, workplaceType });
const goal = (locations: string[], workplaceTypes: Array<"remote" | "hybrid" | "onsite"> = []) => ({ locations, workplaceTypes });

describe("one place rule (Mundelein, 2026-11-23)", () => {
  it("a goal with ways of working but no places never rules a job out for its town", () => {
    const v = placeVerdict(goal([], ["hybrid", "onsite"]), job("Mundelein, Lake County", "onsite"))!;
    expect(v).toMatchObject({ out: false, raw: 1 });
    const unsaid = placeVerdict(goal([], ["remote"]), job("Mundelein, Lake County"))!;
    expect(unsaid.out).toBe(false);
    expect(unsaid.line).toMatch(/doesn't say if it's remote/);
  });

  it("a job clearly done another way is ruled out, and says what the goal wants", () => {
    const v = placeVerdict(goal([], ["remote"]), job("Mundelein, Lake County", "onsite"))!;
    expect(v.out).toBe(true);
    expect(v.line).toBe("In the office (Mundelein, Lake County), and this goal wants remote.");
    expect(placeVerdict(goal(["Remote"]), job("Seattle, WA", "onsite"))!.out).toBe(true);
  });

  it("a goal that lists places names them, not the job's town, as the places chosen", () => {
    const v = placeVerdict(goal(["Chicago, IL"]), job("Mundelein, Lake County"))!;
    expect(v.out).toBe(true);
    expect(v.line).toBe("In Mundelein, Lake County, not one of this goal's places (Chicago, IL).");
    expect(placeVerdict(goal(["Chicago, IL", "Remote"]), job("Mundelein, IL"))!.line).toMatch(/\(Chicago, IL, or remote\)\.$/);
    expect(placeVerdict(goal(["Mundelein"]), job("Mundelein, Lake County"))!).toMatchObject({ out: false, raw: 1 });
  });

  it("no places and no ways of working: no verdict; no location: never ruled out", () => {
    expect(placeVerdict(goal([]), job("Mundelein"))).toBeNull();
    expect(placeVerdict(goal(["Chicago"]), job(null))!.out).toBe(false);
  });
});
