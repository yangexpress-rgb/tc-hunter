import { describeSchedule } from "@/lib/schedule";
import { emailStatus, getPreferences, listGoals } from "@tc-hunter/db";
import { bandLabel, COUNTRIES, countryName, domainLabel, effectiveDomains, GOAL_DOMAINS, GOAL_LEVELS, GOAL_TYPES, goalBand, goalLabel, goalLevelLabel, goalName, goalTypeLabel, TIME_FRAMES, timeFrameLabel, t, type Goal } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { EditDialog } from "@/components/profile/EditDialog";
import { Flash, ProfileNav } from "@/components/profile/Fact";
import { ProfileSection } from "@/components/profile/Section";
import { TopBar } from "@/components/TopBar";
import { goalSummaryLine } from "@/lib/goals";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { deleteGoalAction, saveGoalAction, saveSearchSettingsAction } from "../actions";

export const dynamic = "force-dynamic";

const BACK = "/profile/goals";
const WORKPLACES = [["remote", "Remote"], ["hybrid", "Hybrid"], ["onsite", "In the office"]] as const;
const PER: Record<string, string> = { year: "a year", month: "a month", hour: "an hour" };
const joined = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "object" && x ? (x as { label?: string }).label ?? "" : String(x))).join(", ") : "");

function pay(g: Goal): string | null {
  if (!g.comp) return null;
  const n = g.comp.amount.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return `${g.comp.currency === "USD" ? "$" : `${g.comp.currency} `}${n} ${PER[g.comp.period] ?? ""}`.trim();
}

/** "Target levels: from your roles — Director, Senior director, VP (tick boxes to change)", or the ticked ones. */
function targetLevelsLine(g: Goal): string | null {
  const b = goalBand(g.levels, g.roles, g.occupation);
  if (b.from === "ticked") return `Target levels: ${b.levels.map(goalLevelLabel).join(", ")}`;
  if (b.from === "roles") return `Target levels: from your roles — ${b.levels.map(goalLevelLabel).join(", ")} (tick boxes to change)`;
  return null;
}

function domainsLine(g: Goal): string | null {
  const d = effectiveDomains(g);
  if (!d.domains.length) return null;
  const names = d.domains.map(domainLabel).join(", ");
  return d.from === "industries" ? `Domains: from your industries — ${names} (edit the goal to change)` : `Domains: ${names}`;
}

/** The add and edit form for one goal. */
function GoalForm({ g }: { g?: Goal }) {
  const doms = g ? effectiveDomains(g).domains : [];
  const implied = g && !g.levels.length ? goalBand([], g.roles, g.occupation) : null;
  return (
    <>
      <form action={saveGoalAction} className="stack">
        <input type="hidden" name="back" value={BACK} />
        {g ? <input type="hidden" name="id" value={g.id} /> : null}
        <label>Goal name<input name="label" defaultValue={g?.label ?? ""} maxLength={60} placeholder={g ? goalName(g) : "e.g. Goal-A"} />
          <span className="hint">Shown on jobs and applications. Leave blank to use the one we make from your roles.</span></label>
        <div className="fields">
          <label>When you'd like to get there<select name="time_frame" defaultValue={g?.timeFrame ?? "now"}>
            {TIME_FRAMES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label>Role<input name="roles" defaultValue={g?.roles.join(", ") ?? ""} placeholder="e.g. Operations analyst, Business analyst" />
            <span className="hint">The job titles. Separate with commas.</span></label>
          <label>Occupation<input name="occupation" defaultValue={g?.occupation ?? ""} placeholder="e.g. Operations, Software engineering" />
            <span className="hint">The line of work.</span></label>
          <label>Specialty<input name="specialties" defaultValue={g?.specialties.join(", ") ?? ""} placeholder="e.g. Supply chain analytics, Cross-border trade" />
            <span className="hint">Your own words. We search for these and jobs that mention them score higher.</span></label>
          <label>Language<input name="languages" defaultValue={g?.languages.join(", ") ?? ""} placeholder="e.g. Mandarin, Chinese" />
            <span className="hint">Languages you'd like to use at work. Jobs that ask for them score higher.</span></label>
          <label>Industry<input name="industries" defaultValue={g?.industries.join(", ") ?? ""} placeholder="e.g. Healthcare, Retail" /></label>
          <label>Company<input name="companies" defaultValue={g?.companies.join(", ") ?? ""} placeholder="Any companies you have in mind" /></label>
          <label>Country<input name="countries" list="goal-countries" defaultValue={(g ? g.countries : ["US"]).map(countryName).join(", ")} placeholder="e.g. United States, Canada" />
            <datalist id="goal-countries">{COUNTRIES.map((c) => <option key={c.code} value={c.name} />)}</datalist>
            <span className="hint">One or more, separated by commas. We search only in these countries, and jobs in other countries are set aside. Leave empty for any country.</span></label>
          <label>Location<input name="locations" defaultValue={g?.locations.join(", ") ?? ""} placeholder="e.g. Toronto, Remote in Canada" /></label>
        </div>
        <fieldset>
          <legend>Type</legend>
          {GOAL_TYPES.map(([k, l]) => (
            <label key={k} className="check"><input type="checkbox" name="employment_types" value={k} defaultChecked={g?.employmentTypes.includes(k) ?? false} /> {l}</label>
          ))}
        </fieldset>
        <fieldset>
          <legend>Level</legend>
          {GOAL_LEVELS.map(([k, l]) => (
            <label key={k} className="check"><input type="checkbox" name="levels" value={k} defaultChecked={g?.levels.includes(k) ?? false} /> {l}</label>
          ))}
          <span className="hint">{implied?.levels.length
            ? <>None ticked, so your roles set them: {bandLabel(implied.levels)}. Tick boxes to change.</>
            : <>Pick any that fit. Jobs at these levels come first for this goal. With none ticked, the levels your roles name are used (a role like &quot;Director&quot; means Director level).</>}</span>
        </fieldset>
        <fieldset>
          <legend>Domains</legend>
          <input type="hidden" name="domains_shown" value="1" />
          {GOAL_DOMAINS.map(([k, l]) => (
            <label key={k} className="check"><input type="checkbox" name="domains" value={k} defaultChecked={doms.includes(k)} /> {l}</label>
          ))}
          <span className="hint">The kind of business you want to work in. Jobs in these domains come first; a job in a different domain goes below them, even with the same title. Leave all unticked for any domain.{g && !g.domains && doms.length ? " Ticked from your industries." : ""}</span>
        </fieldset>
        <fieldset>
          <legend>How you'd like to work</legend>
          {WORKPLACES.map(([k, l]) => (
            <label key={k} className="check"><input type="checkbox" name="workplace_types" value={k} defaultChecked={g?.workplaceTypes.includes(k) ?? false} /> {l}</label>
          ))}
        </fieldset>
        <div className="fields">
          <label>Pay you expect<input name="comp_amount" type="number" min="0" step="any" defaultValue={g?.comp?.amount ?? ""} />
            <span className="hint">Jobs that publish lower pay are set aside for this goal. It's never told to an employer.</span></label>
          <label>Currency<input name="comp_currency" defaultValue={g?.comp?.currency ?? "USD"} maxLength={3} /></label>
          <label>Per<select name="comp_period" defaultValue={g?.comp?.period ?? "year"}>
            <option value="year">Year</option><option value="month">Month</option><option value="hour">Hour</option></select></label>
        </div>
        <label className="check"><input type="checkbox" name="active" defaultChecked={g?.active ?? true} /> Use this goal to find jobs now</label>
        <span className="hint">Turn this off for a goal further away. It still marks jobs that are a step toward it.</span>
        <button>Save</button>
      </form>
      {g ? (
        <form action={deleteGoalAction} className="dialog-remove">
          <input type="hidden" name="back" value={BACK} /><input type="hidden" name="id" value={g.id} />
          <button className="link danger">Remove this goal</button>
        </form>
      ) : null}
    </>
  );
}

function GoalItem({ g }: { g: Goal }) {
  const when = [timeFrameLabel(g.timeFrame), g.levels.map(goalLevelLabel).join(", "), g.employmentTypes.map(goalTypeLabel).join(", ")].filter(Boolean).join(" · ");
  const field = [g.occupation, g.industries.join(", ")].filter(Boolean).join(" · ");
  const where = [g.locations.join(", "), g.workplaceTypes.map((w) => WORKPLACES.find(([k]) => k === w)?.[1] ?? w).join(", ")].filter(Boolean).join(" · ");
  const p = pay(g);
  return (
    <article className="profile-item">
      <div className="item-body">
        <h3>{goalLabel(g)}{g.active ? null : <> <span className="chip draft">Not used to find jobs</span></>}</h3>
        {goalSummaryLine(g) ? <p className="muted goal-summary">{goalSummaryLine(g)}</p> : null}
        <p className="item-sub">{when}</p>
        {field ? <p className="muted">{field}</p> : null}
        {targetLevelsLine(g) ? <p className="muted">{targetLevelsLine(g)}</p> : null}
        {domainsLine(g) ? <p className="muted">{domainsLine(g)}</p> : null}
        {g.specialties.length ? <p className="muted">Specialty: {g.specialties.join(", ")}</p> : null}
        {g.languages.length ? <p className="muted">Language: {g.languages.join(", ")}</p> : null}
        {g.companies.length ? <p className="muted">At {g.companies.join(", ")}</p> : null}
        {p ? <p className="muted">Pay you expect: {p}</p> : null}
        {where ? <p className="muted">{where}</p> : null}
        <p className="muted">Country: {g.countries.length ? g.countries.map(countryName).join(", ") : "Any"}</p>
      </div>
      <EditDialog icon="pencil" label="Edit this goal" title="Edit goal"><GoalForm g={g} /></EditDialog>
    </article>
  );
}

/** Goals (was "What you want"): several goals, each with when, what kind, level, role, occupation, industry, company, pay and place. */
export default async function GoalsPage(props: PageProps) {
  const session = await requireSession();
  const { pool } = app();
  const { cfg } = app();
  const [{ saved, error }, goals, p, mail] = await Promise.all([flashOf(props), listGoals(pool, session), getPreferences(pool, session), emailStatus(pool, cfg, session)]);
  const linkedin = (g: Goal) => {
    const q = new URLSearchParams({ keywords: g.roles[0] ?? g.occupation ?? "" });
    const where = g.locations.find((l) => !/^remote$/i.test(l.trim()));
    // A place on its own ("NC") goes with the goal's country, so LinkedIn searches the right one.
    const country = g.countries.length === 1 ? countryName(g.countries[0]!) : null;
    if (where) q.set("location", country && !new RegExp(country, "i").test(where) ? `${where}, ${country}` : where);
    else if (country) q.set("location", country);
    if (g.workplaceTypes.includes("remote") && !where) q.set("f_WT", "2");
    return `https://www.linkedin.com/jobs/search/?${q}`;
  };
  const v = p ?? {};
  return (
    <>
      <TopBar signedIn />
      <h1>{t("profile.preferences.title")}</h1>
      <ProfileNav current={BACK} />
      <Flash saved={saved} error={error} />

      <ProfileSection title="Goals" id="goals" addTitle="Add a goal" addForm={<GoalForm />}
        empty={goals.length ? undefined : "Add a goal so we know what jobs to look for. You can have more than one, for now and for later."}>
        {goals.length ? <p className="muted small">Each job is scored against every goal in use, and keeps the one it fits best.</p> : null}
        {goals.map((g) => <GoalItem key={g.id} g={g} />)}
      </ProfileSection>

      {goals.some((g) => g.active && (g.roles.length || g.occupation)) ? (
        <section className="card profile-section" id="linkedin">
          <header className="section-head"><h2>Bring in LinkedIn's jobs too</h2></header>
          <p>LinkedIn doesn't let other apps search it, and we never sign in as you. LinkedIn can email you new jobs, though, and we read those emails for you:</p>
          <ol>
            <li>{mail?.status === "connected" ? <>Your Gmail is connected{mail.address ? ` (${mail.address})` : ""}. Make sure LinkedIn sends alerts to this address.</> : <><a href="/settings/email">Connect your Gmail</a>, the one LinkedIn emails.</>}</li>
            <li>Open each goal's search on LinkedIn below, and switch on <strong>Set alert</strong> (daily, by email).</li>
            <li>That's it. Jobs in those emails show up in Jobs under the goal they fit, scored like any other.</li>
          </ol>
          <ul className="plain">
            {goals.filter((g) => g.active && (g.roles.length || g.occupation)).map((g) => (
              <li key={g.id}><a href={linkedin(g)} target="_blank" rel="noreferrer">{goalLabel(g)} on LinkedIn</a></li>
            ))}
          </ul>
          <p className="muted small">From each alert we keep only the job's title, company, place and link, never the rest of the email.</p>
        </section>
      ) : null}

      <section className="card profile-section" id="settings">
        <header className="section-head">
          <h2>Search settings</h2>
          <EditDialog icon="pencil" label="Edit search settings" title="Search settings">
            <form action={saveSearchSettingsAction} className="stack">
              <input type="hidden" name="back" value={BACK} />
              <label>Employers to skip<input name="employers_exclude" defaultValue={joined(v.employers_exclude)} /></label>
              <label>Industries to skip<input name="industries_exclude" defaultValue={joined(v.industries_exclude)} /></label>
              <label>Deal-breakers<input name="deal_breakers" defaultValue={joined(v.deal_breakers)} placeholder="e.g. night shifts, commission only" /></label>
              <label>Words a job must mention<input name="must_have_keywords" defaultValue={joined(v.must_have_keywords)} /></label>
              <div className="fields">
                <label>Tell me about new jobs<select name="notify_pref" defaultValue={v.notify_pref ?? "in_app"}>
                  <option value="in_app">Here in the app</option><option value="daily_digest">In a daily email</option><option value="weekly_digest">In a weekly email</option></select></label>
              </div>
              <Details summary="More choices">
                <label>Level<input name="seniority" defaultValue={joined(v.seniority)} placeholder="e.g. entry, associate" /></label>
                <div className="fields">
                  <label>Resume length (pages)<input name="tailor_target_pages" type="number" min="1" max="4" defaultValue={v.tailor_target_pages ?? 2} /></label>
                  <label>Applications a week I'm aiming for<input name="weekly_application_budget" type="number" min="1" defaultValue={v.weekly_application_budget ?? ""} />
                    <span className="hint">Advice only. Nothing is ever blocked.</span></label>
                  <label>Only prepare a resume for jobs scoring at least<input name="min_score_to_tailor" type="number" min="0" max="100" defaultValue={v.min_score_to_tailor ?? ""} /></label>
                </div>
                <label className="check"><input type="checkbox" name="weekly_review_enabled" defaultChecked={v.weekly_review_enabled ?? true} /> Send me a short weekly look back</label>
              </Details>
              <button>Save</button>
            </form>
          </EditDialog>
        </header>
        <p className="muted small">These apply to every goal.</p>
        <p className="item-sub">Looks for new jobs: {describeSchedule({ schedule: v.scan_schedule ?? "daily", scanDay: v.scan_day ?? 1, scanTime: v.scan_time ?? "18:00", scanTz: v.scan_tz ?? "America/New_York" })}. <a href="/jobs/sources#schedule">Change</a></p>
        {joined(v.employers_exclude) ? <p className="muted">Skipping: {joined(v.employers_exclude)}</p> : null}
        {joined(v.industries_exclude) ? <p className="muted">Industries skipped: {joined(v.industries_exclude)}</p> : null}
        {joined(v.deal_breakers) ? <p className="muted">Deal-breakers: {joined(v.deal_breakers)}</p> : null}
        {v.weekly_application_budget ? <p className="muted">Aiming for {v.weekly_application_budget} applications a week</p> : null}
      </section>
    </>
  );
}
