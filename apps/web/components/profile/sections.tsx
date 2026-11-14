import type { getProfile, profileDuplicates } from "@tc-hunter/db";
import { sortExperience, t } from "@tc-hunter/domain";
import { EditDialog } from "@/components/profile/EditDialog";
import { RowRef } from "@/components/profile/Fact";
import { FactList } from "@/components/profile/FactList";
import { AddForm, EditForm, Item, ProfileSection } from "@/components/profile/Section";
import { DuplicateBanner } from "@/components/profile/Digest";
import { CATEGORY_LABELS, dateRange, duration, employmentLabel, PROFICIENCY_LABELS, showMonth } from "@/lib/profile";
import { addEvidenceAction, removeDuplicatesAction, removeEvidenceAction, verifyRoleAction } from "@/app/profile/actions";

/**
 * The sections of the "About you" page, in the order LinkedIn shows them:
 * experience (with projects, volunteering and coursework), education,
 * licences and certifications, skills, honours and awards.
 */

type Profile = Awaited<ReturnType<typeof getProfile>>;

const UNITS: Record<string, string> = { percent: "%", usd: "$", count: "", multiplier: "x" };

/** Sections in the order LinkedIn shows them. */
const GROUPS: Array<[string, string, string[]]> = [
  ["experience", "Experience", ["full_time", "part_time", "contract", "internship"]],
  ["projects", "Projects", ["project"]],
  ["volunteering", "Volunteering", ["volunteer"]],
  ["activities", "Activities and coursework", ["other", "coursework"]],
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
export function ExperienceSections({ profile, targets, sort, copies }: { profile: Profile; targets: string[]; sort?: string; copies: Awaited<ReturnType<typeof profileDuplicates>> }) {
  const by = sort === "relevance" && targets.length ? "relevance" : "date";
  const sortable = profile.experience.map((e) => ({
    title: e.title as string, employer_name: e.employer_name as string | null, start_date: e.start_date as Date, end_date: e.end_date as Date | null,
    sort_order: e.sort_order as number, bullets: (e.bullets as Array<Record<string, any>>).map((b) => String(b.text)), full: e,
  }));
  const rows = sortExperience(sortable, by, targets).map((x) => x.full);
  const back = `/profile${by === "relevance" ? "?sort=relevance" : ""}#experience`;
  return (
    <>
      <DuplicateBanner dups={copies} back={back} action={removeDuplicatesAction} />
      {GROUPS.map(([id, label, types], i) => {
        const list = rows.filter((e) => types.includes(e.employment_type));
        if (!list.length && i > 0) return null;
        return (
          <ProfileSection key={id} id={id} title={label} addTitle={`Add to ${label}`} addForm={<AddForm table="experience_item" back={back} />}
            empty={list.length ? undefined : "Nothing here yet. Use the plus to add a role."}>
            {i === 0 ? (
              <p className="sortbar">
                Sort: <a href="/profile#experience" aria-current={by === "date" ? "true" : undefined}>Most recent</a>
                {targets.length ? <a href="/profile?sort=relevance#experience" aria-current={by === "relevance" ? "true" : undefined}>Closest to the roles you want</a>
                  : <span className="muted"> (add a role in <a href="/profile/goals">Goals</a> to sort by fit)</span>}
              </p>
            ) : null}
            {byOrg(list as Role[]).map((roles) => <OrgBlock key={roles[0]!.id} roles={roles} back={back} />)}
          </ProfileSection>
        );
      })}
    </>
  );
}

export function EducationSection({ profile }: { profile: Profile }) {
  return (
    <FactList table="education_item" rows={profile.education} back="/profile#education" addLabel="Add education"
      sectionTitle="Education" id="education" editLabel="Edit education"
      title={(r) => r.institution}
      describe={(r) => [[r.degree, r.field].filter(Boolean).join(", "), [r.start_date ? showMonth(r.start_date) : null, r.end_date ? showMonth(r.end_date) : null].filter(Boolean).join(" – "), r.honours]} />
  );
}

const KIND: Record<string, string> = { certification: "Certification", licence: "Licence", clearance: "Clearance" };

export function CertificationsSection({ profile }: { profile: Profile }) {
  return (
    <FactList table="credential" rows={profile.credentials} back="/profile#certifications" addLabel="Add a certification or licence"
      sectionTitle="Licenses & certifications" id="certifications" editLabel="Edit certification"
      title={(r) => r.name}
      describe={(r) => [r.issuer, [KIND[r.kind], r.issued_on ? `Issued ${showMonth(r.issued_on)}` : null, r.expires_on ? `Expires ${showMonth(r.expires_on)}` : null].filter(Boolean).join(" · ")]} />
  );
}

export function AwardsSection({ profile }: { profile: Profile }) {
  return (
    <FactList table="honor_award" rows={profile.awards} back="/profile#awards" addLabel="Add an honor or award"
      sectionTitle="Honors & awards" id="awards" editLabel="Edit honor or award"
      title={(r) => r.title}
      describe={(r) => [[r.issuer, r.awarded_on ? showMonth(r.awarded_on) : null].filter(Boolean).join(" · "), r.description]} />
  );
}

/**
 * Skills (brief 5.1): grouped by kind. A skill counts in matching only with
 * proof: something you did that shows it. The level is always yours to set.
 */
function skillProofOptions(profile: Profile): Array<[string, string]> {
  return [
    ...profile.experience.flatMap((e) => [
      [`experience_item:${e.id}`, `${e.title}${e.employer_name ? `, ${e.employer_name}` : ""}`] as [string, string],
      ...e.bullets.map((b) => [`experience_bullet:${b.id}`, `  · ${String(b.text).slice(0, 90)}`] as [string, string]),
    ]),
    ...profile.education.map((ed) => [`education_item:${ed.id}`, `${ed.institution}${ed.degree ? `, ${ed.degree}` : ""}`] as [string, string]),
    ...profile.credentials.map((c) => [`credential:${c.id}`, c.name] as [string, string]),
  ];
}

function SkillItem({ s, back, proofOptions }: { s: Profile["skills"][number]; back: string; proofOptions: Array<[string, string]> }) {
  return (
    <Item table="skill" row={s} back={back} title={s.canonical_name} editTitle={`Edit ${s.canonical_name}`}
      lines={[
        s.proficiency ? `${PROFICIENCY_LABELS.find(([k]) => k === s.proficiency)?.[1]}${s.proficiency_set_by === "import_as_stated" ? " (as your resume says)" : ""}` : null,
        s.evidence.length ? s.evidence.map((ev) => ev.label).join(" · ") : <span className="hint">{t("profile.skills.no_proof")}</span>,
      ]}
      dialogExtra={
        <div className="dialog-section">
          <h3>Proof</h3>
          {s.evidence.length ? (
            <ul className="bullets">
              {s.evidence.map((ev) => (
                <li key={ev.id}>{ev.label}{" "}
                  <form action={removeEvidenceAction} className="inline"><input type="hidden" name="back" value={back} /><input type="hidden" name="evidence_id" value={ev.id} /><button className="link">Unlink</button></form>
                </li>
              ))}
            </ul>
          ) : <p className="hint">{t("profile.skills.no_proof")}</p>}
          {proofOptions.length ? (
            <form action={addEvidenceAction} className="stack">
              <input type="hidden" name="back" value={back} /><input type="hidden" name="skill_id" value={s.id} />
              <label>Shown by<select name="target" required defaultValue=""><option value="" disabled>Pick something you did</option>{proofOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
              <button className="secondary">Link proof</button>
            </form>
          ) : null}
        </div>
      } />
  );
}

/** Skills, grouped by kind. Spoken languages have their own section below (Yong, 2026-11-14). */
export function SkillsSection({ profile }: { profile: Profile }) {
  const back = "/profile#skills";
  const proofOptions = skillProofOptions(profile);
  const skills = profile.skills.filter((s) => s.category !== "language");
  const noProof = skills.filter((s) => s.evidence.length === 0);
  return (
    <>
      {noProof.length ? (
        <p id="no-proof" className="status">{noProof.length} {noProof.length === 1 ? "skill has" : "skills have"} no proof yet. Link each to something you did so it counts in matching.</p>
      ) : null}
      <ProfileSection id="skills" title="Skills" addTitle="Add a skill" addForm={<AddForm table="skill" back={back} />}
        empty={skills.length ? undefined : "No skills yet. Use the plus to add one."}>
        {CATEGORY_LABELS.filter(([cat]) => cat !== "language").map(([cat, label]) => {
          const list = skills.filter((s) => s.category === cat);
          if (!list.length) return null;
          return (
            <div key={cat} className="skill-group">
              <h3 className="group-label">{label}</h3>
              {list.map((s) => <SkillItem key={s.id} s={s} back={back} proofOptions={proofOptions} />)}
            </div>
          );
        })}
      </ProfileSection>
    </>
  );
}

/** Languages you speak: the ones read from your resume or LinkedIn, and any you add. */
export function LanguagesSection({ profile }: { profile: Profile }) {
  const back = "/profile#languages";
  const langs = profile.skills.filter((s) => s.category === "language");
  return (
    <ProfileSection id="languages" title="Languages" addTitle="Add a language" addForm={<AddForm table="skill" back={back} values={{ category: "language" }} />}
      empty={langs.length ? undefined : "No languages yet. Use the plus to add one, e.g. Mandarin."}>
      {langs.length ? <p className="muted small">Jobs that ask for one of these count it as a skill you have once it has proof. To have jobs that ask for a language score higher, add it to a <a href="/profile/goals">goal</a> too.</p> : null}
      {langs.map((s) => <SkillItem key={s.id} s={s} back={back} proofOptions={skillProofOptions(profile)} />)}
    </ProfileSection>
  );
}
