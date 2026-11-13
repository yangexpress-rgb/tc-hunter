import { getPreferences } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Flash, ProfileNav } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { savePreferencesAction } from "../actions";

export const dynamic = "force-dynamic";

const joined = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "object" && x ? (x as { label?: string }).label ?? "" : String(x))).join(", ") : "");

/** Hunt preferences (brief 5.1): what to look for. Layer 1 is the essentials; the rest is one click away. */
export default async function PreferencesPage(props: PageProps) {
  const session = await requireSession();
  const { pool } = app();
  const [{ saved, error }, p] = await Promise.all([flashOf(props), getPreferences(pool, session)]);
  const v = p ?? {};
  const wt: string[] = v.workplace_types ?? [];
  return (
    <>
      <TopBar signedIn />
      <h1>{t("profile.preferences.title")}</h1>
      <ProfileNav current="/profile/preferences" />
      <Flash saved={saved} error={error} />
      <form action={savePreferencesAction} className="card stack">
        <input type="hidden" name="back" value="/profile/preferences" />
        <label>Job titles you want<input name="target_titles" defaultValue={joined(v.target_titles)} placeholder="e.g. Operations analyst, Business analyst" />
          <span className="hint">Separate with commas.</span></label>
        <label>Where<input name="locations" defaultValue={joined(v.locations)} placeholder="e.g. Toronto, Remote in Canada" /></label>
        <fieldset>
          <legend>How you'd like to work</legend>
          {([["remote", "Remote"], ["hybrid", "Hybrid"], ["onsite", "In the office"]] as const).map(([k, l]) => (
            <label key={k} className="check"><input type="checkbox" name="workplace_types" value={k} defaultChecked={wt.includes(k)} /> {l}</label>
          ))}
        </fieldset>
        <div className="fields">
          <label>Lowest pay you'd consider<input name="salary_floor_amount" type="number" min="0" step="any" defaultValue={v.salary_floor_amount ?? ""} />
            <span className="hint">Only used to filter jobs. It's never told to an employer.</span></label>
          <label>Currency<input name="salary_floor_currency" defaultValue={v.salary_floor_currency ?? "USD"} maxLength={3} /></label>
          <label>Per<select name="salary_floor_period" defaultValue={v.salary_floor_period ?? "year"}>
            <option value="year">Year</option><option value="month">Month</option><option value="hour">Hour</option></select></label>
        </div>
        <label>Where you want to be one day<input name="long_term_target_role" defaultValue={v.long_term_target_role ?? ""} placeholder="e.g. Head of operations" />
          <span className="hint">We'll favour jobs that build toward it.</span></label>

        <Details summary="More choices">
          <label>Level<input name="seniority" defaultValue={joined(v.seniority)} placeholder="e.g. entry, associate" /></label>
          <label>Area of work<input name="target_function" defaultValue={v.target_function ?? ""} placeholder="e.g. operations" /></label>
          <label>Industries you like<input name="industries_include" defaultValue={joined(v.industries_include)} /></label>
          <label>Industries to skip<input name="industries_exclude" defaultValue={joined(v.industries_exclude)} /></label>
          <label>Employers to skip<input name="employers_exclude" defaultValue={joined(v.employers_exclude)} /></label>
          <label>Words a job must mention<input name="must_have_keywords" defaultValue={joined(v.must_have_keywords)} /></label>
          <label>Deal-breakers<input name="deal_breakers" defaultValue={joined(v.deal_breakers)} placeholder="e.g. night shifts, commission only" /></label>
          <div className="fields">
            <label>Look for new jobs<select name="scan_schedule" defaultValue={v.scan_schedule ?? "daily"}>
              <option value="daily">Every day</option><option value="weekly">Every week</option><option value="manual">Only when I ask</option></select></label>
            <label>Tell me about new jobs<select name="notify_pref" defaultValue={v.notify_pref ?? "in_app"}>
              <option value="in_app">Here in the app</option><option value="daily_digest">In a daily email</option><option value="weekly_digest">In a weekly email</option></select></label>
            <label>Resume length (pages)<input name="tailor_target_pages" type="number" min="1" max="4" defaultValue={v.tailor_target_pages ?? 2} /></label>
            <label>Applications a week I'm aiming for<input name="weekly_application_budget" type="number" min="1" defaultValue={v.weekly_application_budget ?? ""} />
              <span className="hint">Advice only. Nothing is ever blocked.</span></label>
            <label>Only prepare a resume for jobs scoring at least<input name="min_score_to_tailor" type="number" min="0" max="100" defaultValue={v.min_score_to_tailor ?? ""} /></label>
          </div>
          <label className="check"><input type="checkbox" name="weekly_review_enabled" defaultChecked={v.weekly_review_enabled ?? true} /> Send me a short weekly look back</label>
        </Details>
        <button>Save</button>
      </form>
    </>
  );
}
