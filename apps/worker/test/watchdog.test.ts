import { describe, expect, it } from "vitest";
import { stuckVerdict } from "../src/watchdog";

const M = 60_000;
describe("worker watchdog", () => {
  it("leaves a long search alone while it keeps moving", () => {
    expect(stuckVerdict({ kind: "scan", at: 0, beat: 60 * M }, 62 * M)).toBeNull();
  });
  it("stops a search that has gone quiet", () => {
    expect(stuckVerdict({ kind: "scan", at: 0, beat: 10 * M }, 41 * M)).toEqual({ minutes: 41, quiet_minutes: 31 });
  });
  it("stops a search past the hard cap even if moving", () => {
    expect(stuckVerdict({ kind: "scan", at: 0, beat: 240 * M }, 241 * M)).not.toBeNull();
  });
  it("measures work without progress from its start, as before", () => {
    expect(stuckVerdict({ kind: "email_check", at: 0, beat: 0 }, 14 * M)).toBeNull();
    expect(stuckVerdict({ kind: "email_check", at: 0, beat: 0 }, 16 * M)).not.toBeNull();
    expect(stuckVerdict({ kind: "unknown", at: 0, beat: 0 }, 21 * M)).not.toBeNull();
  });
});
