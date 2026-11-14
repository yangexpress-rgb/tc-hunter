import { getPreferences, getProfile, profileDuplicates } from "@tc-hunter/db";
import { sortExperience, t } from "@tc-hunter/domain";
import { EditDialog } from "@/components/profile/EditDialog";
import { Flash, ProfileNav, RowRef } from "@/components/profile/Fact";
import { AddForm, EditForm, ProfileSection } from "@/components/profile/Section";
import { TopBar } from "@/components/TopBar";
import { dateRange, duration, employmentLabel, flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { removeDuplicatesAction, verifyRoleAction } from "../actions";
import { DuplicateBanner } from "@/components/profile/Digest";

export const dynamic = "force-dynamic";

const UNITS: Record<string, string> = { percent: "%", usd: "$", count: "", multiplier: "x" };

/** Sections in the order LinkedIn shows them. */
const GROUPS: Array<[string, string[]]> = [
  ["Experience", ["full_time", "part_time", "contract", "internship"]],
  ["Projects", ["project"]],
  ["Volunteering", ["volunteer"]],
  ["Activities and coursework", ["other", "coursework"]],
];

function Bullet({ b, back, roleDraft }: { b: Record<string, any>; back: string; roleDraft?: boolean }) {
  const num = b.metric_value !== null && b.metric_value !== undefined
    ? `${b.metric_unit === "usd" ? "$" : ""}${Number(b.metric_value).toLocaleString()}${UNITS[b.metric_unit] && b.metric_unit !== "usd" ? UNITS[b.metric_unit] : ""}` : null;
  return (
    <li className="bullet-line">
      <EditDialog icon="pencil" label="Edit this line" title={b.kind === "responsibility" ? "Edit responsibility" : "Edit outcome"}>
        {num ? <p className="muted small">Number kept exactly: {num} {b.metric_context ?? ""}</p> : null}
        <EditForm table="experience_bullet" row={b} back={back} />
      </EditDialog>
      <span>
        {b.text}
        {b.verification !== "verified" && !roleDraft ? <> <span className="unconfirmed-dot" title={t("profile.draft")} aria-label={t("profile.draft")} /></> : null}
      </span>
    </li>
  );
}

type Role = Record<string, any> & { bullets: Array<Record<string, any>> };

/** A square with the organisation's first letter, in a colour picked from its name (LinkedIn shows a logo here). */
function OrgMark({ name }: { name: string | null }) {
  const n = (name ?? "").trim();
  let h = 0;
  for (const ch of n.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return <span className="org-mark" style={{ background: `hsl(${h} 45% 38%)` }} aria-hidden="true">{(n.match(/[A-Za-z0-9]/)?.[0] ?? "·").toUpperCase()}</span>;
}

const orgKey = (e: Role) => String(e.employer_name ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\b(inc|llc|ltd|corp|corporation|co|plc|gmbh)\b/g, "").trim();

/** Roles next to each other at the same organisation sit under one heading, as on LinkedIn. */
function byOrg(rows: Role[]): Role[][] {
  const out: Role[][] = [];
  for (const e of rows) {
    const last = out[out.length - 1];
    if (last && orgKey(e) && orgKey(last[0]!) === orgKey(e)) last.push(e); else out.push([e]);
  }
  return out;
}

/** What you did and what came of it: the first couple of lines, then "…more" for the rest. */
function RoleText({ e, back }: { e: Role; back: string }) {
  const resp = e.bullets.filter((b) => b.kind === "responsibility");
  const outs = e.bullets.filter((b) => b.kind !== "responsibility");
  const lines = [...resp, ...outs];
  const both = resp.length > 0 && outs.length > 0;
  const draft = e.verification !== "verified";
  const full = (
    <>
      {e.description ? <p className="role-description">{e.description}</p> : null}
      {resp.length ? <>{both ? <h4>Responsibilities</h4> : null}<ul className="bullets">{resp.map((b) => <Bullet key={b.id} b={b} back={back} roleDraft={draft} />)}</ul></> : null}
      {outs.length ? <>{both ? <h4>Outcomes</h4> : null}<ul className="bullets">{outs.map((b) => <Bullet key={b.id} b={b} back={back} roleDraft={draft} />)}</ul></> : null}
    </>
  );
  if (!lines.length && !e.description) return null;
  if (lines.length <= 2 && !(e.description && lines.length)) return <div className="role-text">{full}</div>;
  const preview = e.description ? [String(e.description)] : lines.slice(0, 2).map((b) => String(b.text));
  return (
    <div className="role-text">
      <ul className="bullets preview">{preview.map((x, i) => <li key={i}>{x}</li>)}</ul>
      <details className="more">
        <summary><span className="more-open">…more</span><span className="more-close">see less</span></summary>
        {full}
      </details>
    </div>
  );
}

/** The quiet note and one Confirm for a role read from a resume (it confirms the lines under it too). */
function RoleConfirm({ e, back }: { e: Role; back: string }) {
  const drafts = (e.verification !== "verified" ? 1 : 0) + e.bullets.filter((b) => b.verification !== "verified").length;
  if (!drafts) return null;
  return (
    <span className="unconfirmed">
      <span className="dot" aria-hidden="true" /> {e.verification !== "verified" ? t("profile.draft") : `${drafts} ${drafts === 1 ? "line" : "lines"} from your resume not confirmed yet`}
      <form action={verifyRoleAction} className="inline"><RowRef table="experience_item" id={e.id} back={back} /><button className="link">{t("profile.check_cta")}</button></form>
    </span>
  );
}

function RoleTools({ e, back }: { e: Role; back: string }) {
  return (
    <div className="item-tools">
      {!e.end_date ? <span className="present">Present</span> : null}
      <EditDialog icon="plus" label="Add a responsibility or outcome" title="Add a responsibility or outcome">
        <AddForm table="experience_bullet" back={back} extra={<input type="hidden" name="experience_item_id" value={e.id} />} />
      </EditDialog>
      <EditDialog icon="pencil" label={`Edit ${e.title}`} title="Edit experience">
        <EditForm table="experience_item" row={e} back={back} removeLabel="Remove this role and everything under it" />
      </EditDialog>
    </div>
  );
}

const when = (e: Role) => {
  const span = duration(e.start_date, e.end_date);
  return `${dateRange(e.start_date, e.end_date, e.date_precision)}${span ? ` · ${span}` : ""}`;
};

/** One organisation, read like LinkedIn: its mark on the left; one role in full, or several roles on a timeline. */
function OrgBlock({ roles, back }: { roles: Role[]; back: string }) {
  const first = roles[0]!;
  if (roles.length === 1) {
    const e = first;
    return (
      <article className="org-block role">
        <OrgMark name={e.employer_name ?? e.title} />
        <div className="org-body">
          <header className="role-head">
            <div>
              <h3>{e.title}</h3>
              <p className="item-sub">{[e.employer_name !== e.title ? e.employer_name : null, employmentLabel(e.employment_type)].filter(Boolean).join(" · ")}</p>
              <p className="muted">{when(e)}</p>
              {e.location ? <p className="muted">{e.location}</p> : null}
            </div>
            <RoleTools e={e} back={back} />
          </header>
          <RoleText e={e} back={back} />
          <RoleConfirm e={e} back={back} />
        </div>
      </article>
    );
  }
  const starts = roles.map((r) => new Date(r.start_date).getTime());
  const open = roles.some((r) => !r.end_date);
  const ends = roles.map((r) => (r.end_date ? new Date(r.end_date).getTime() : Date.now()));
  const total = duration(new Date(Math.min(...starts)), open ? null : new Date(Math.max(...ends)));
  const types = [...new Set(roles.map((r) => employmentLabel(r.employment_type)))];
  const places = [...new Set(roles.map((r) => r.location).filter(Boolean))];
  return (
    <article className="org-block">
      <OrgMark name={first.employer_name} />
      <div className="org-body">
        <header>
          <h3>{first.employer_name}</h3>
          <p className="item-sub">{[types.length === 1 ? types[0] : null, total].filter(Boolean).join(" · ")}</p>
          {places.length === 1 ? <p className="muted">{places[0]}</p> : null}
        </header>
        <ol className="timeline">
          {roles.map((e) => (
            <li key={e.id} className="role">
              <header className="role-head">
                <div>
                  <h3>{e.title}</h3>
                  <p className="muted">{when(e)}</p>
                  {e.location && places.length > 1 ? <p className="muted">{e.location}</p> : null}
                </div>
                <RoleTools e={e} back={back} />
              </header>
              <RoleText e={e} back={back} />
              <RoleConfirm e={e} back={back} />
            </li>
          ))}
        </ol>
      </div>
    </article>
  );
}

/** Experience (brief 5.1, P2): jobs, internships, projects, volunteering and coursework, sortable by date or relevance. */
export default async function ExperiencePage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error, params }, profile, prefs, copies] = await Promise.all([flashOf(props), getProfile(pool, cfg, session), getPreferences(pool, session), profileDuplicates(pool, session)]);
  const targets: string[] = [...(prefs?.target_titles ?? []), ...(prefs?.long_term_target_role ? [prefs.long_term_target_role] : [])];
  const by = params.sort === "relevance" && targets.length ? "relevance" : "date";
  const sortable = profile.experience.map((e) => ({
    title: e.title as string, employer_name: e.employer_name as string | null, start_date: e.start_date as Date, end_date: e.end_date as Date | null,
    sort_order: e.sort_order as number, bullets: e.bullets.map((b) => String(b.text)), full: e,
  }));
  const rows = sortExperience(sortable, by, targets).map((x) => x.full);
  const back = `/profile/experience${by === "relevance" ? "?sort=relevance" : ""}`;

  return (
    <>
      <TopBar signedIn />
      <h1>{t("profile.experience.title")}</h1>
      <ProfileNav current="/profile/experience" />
      <p className="muted">{t("profile.experience.hint")}</p>
      <Flash saved={saved} error={error} />
      <DuplicateBanner dups={copies} back={back} action={removeDuplicatesAction} />
      <p className="sortbar">
        Sort: <a href="/profile/experience" aria-current={by === "date" ? "true" : undefined}>Most recent</a>
        {targets.length ? <a href="/profile/experience?sort=relevance" aria-current={by === "relevance" ? "true" : undefined}>Closest to the roles you want</a>
          : <span className="muted"> (add target roles in <a href="/profile/preferences">What you want</a> to sort by fit)</span>}
      </p>

      {GROUPS.map(([label, types], i) => {
        const list = rows.filter((e) => types.includes(e.employment_type));
        if (!list.length && i > 0) return null;
        return (
          <ProfileSection key={label} title={label} addTitle={`Add to ${label}`} addForm={<AddForm table="experience_item" back={back} />}
            empty={list.length ? undefined : "Nothing here yet. Use the plus to add a role."}>
            {byOrg(list as Role[]).map((roles) => <OrgBlock key={roles[0]!.id} roles={roles} back={back} />)}
          </ProfileSection>
        );
      })}
    </>
  );
}
