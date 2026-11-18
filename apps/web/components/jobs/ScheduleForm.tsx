"use client";
import { useState } from "react";
import { DAYS, TIMES, ZONES, timeLabel } from "@/lib/schedule";

/** When every source is searched by itself (Yong, 2026-11-17): how often, which day if weekly, and what time. */
export function ScheduleForm({ action, schedule, day, time, tz, back }: {
  action: (form: FormData) => Promise<void>; schedule: string; day: number; time: string; tz: string; back: string;
}) {
  const [often, setOften] = useState(schedule);
  return (
    <form action={action} className="fields schedule-form" id="schedule">
      <input type="hidden" name="back" value={back} />
      <label>Search every source<select name="scan_schedule" value={often} onChange={(e) => setOften(e.target.value)}>
        <option value="daily">Every day</option><option value="weekly">Every week</option><option value="manual">Only when I ask</option></select></label>
      {often === "weekly" ? (
        <label>On<select name="scan_day" defaultValue={String(day)}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></label>
      ) : <input type="hidden" name="scan_day" value={day} />}
      {often !== "manual" ? <>
        <label>At<select name="scan_time" defaultValue={time}>{TIMES.map((t) => <option key={t} value={t}>{timeLabel(t)}</option>)}</select></label>
        <label>Time zone<select name="scan_tz" defaultValue={tz}>{ZONES.map(([z, l]) => <option key={z} value={z}>{l}</option>)}</select></label>
      </> : <><input type="hidden" name="scan_time" value={time} /><input type="hidden" name="scan_tz" value={tz} /></>}
      <button className="secondary">Save schedule</button>
    </form>
  );
}
