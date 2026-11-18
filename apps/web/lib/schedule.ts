/** The search schedule's choices and how it reads (Yong, 2026-11-17). Shared by the page, the form and the status line. */
export const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
export const ZONES: Array<[string, string]> = [
  ["America/New_York", "ET"], ["America/Chicago", "CT"], ["America/Denver", "MT"], ["America/Phoenix", "Arizona"],
  ["America/Los_Angeles", "PT"], ["America/Anchorage", "Alaska"], ["Pacific/Honolulu", "Hawaii"], ["UTC", "UTC"],
];
export const TIMES: string[] = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, "0")}:${i % 2 ? "30" : "00"}`);

export function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}
export const zoneLabel = (tz: string) => ZONES.find(([z]) => z === tz)?.[1] ?? tz;

/** "Every day at 6 PM ET", "Every Monday at 6 PM ET", "Only when you ask". */
export function describeSchedule(s: { schedule: string; scanDay: number; scanTime: string; scanTz: string }): string {
  if (s.schedule === "manual") return "Only when you ask";
  const at = `at ${timeLabel(s.scanTime)} ${zoneLabel(s.scanTz)}`;
  return s.schedule === "weekly" ? `Every ${DAYS[s.scanDay] ?? "Monday"} ${at}` : `Every day ${at}`;
}
