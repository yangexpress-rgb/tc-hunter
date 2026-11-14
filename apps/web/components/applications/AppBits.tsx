/** Small pieces shared by the Applications, Home and Reports screens. Layer 1 language only. */

const ymdLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** "due today", "due in 3 days", "2 days late". Dates from the database come back as local midnight. */
export function dueText(due: Date, today: string): { text: string; late: boolean } {
  const d = ymdLocal(due);
  const days = Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days === 0) return { text: "due today", late: true };
  if (days < 0) return { text: `${-days} ${days === -1 ? "day" : "days"} late`, late: true };
  return { text: days === 1 ? "due tomorrow" : `due in ${days} days`, late: false };
}

export function dateInput(due: Date | string | null): string {
  if (!due) return "";
  return due instanceof Date ? ymdLocal(due) : String(due).slice(0, 10);
}

export function when(d: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }).format(new Date(d));
}

export function day(d: Date | string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short", year: "numeric" }).format(new Date(d));
}

/** The wall-clock value for a datetime-local input, in the applicant's time zone. */
export function localInput(d: Date | string | null, timeZone: string): string {
  if (!d) return "";
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(new Date(d)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** The weekly budget (P5): advice, never a block. */
export function BudgetLine({ budget }: { budget: { cap: number | null; used: number } }) {
  if (!budget.cap) return <p className="muted">{budget.used} {budget.used === 1 ? "application" : "applications"} this week. <a href="/profile/preferences">Set a weekly aim</a></p>;
  const over = budget.used >= budget.cap;
  return (
    <p className={over ? "warn" : "muted"}>
      {budget.used} of the {budget.cap} applications you aim for this week.
      {over ? " You've reached your aim. Fewer, better-fitted applications usually do better, but it's your call." : ""}
    </p>
  );
}
