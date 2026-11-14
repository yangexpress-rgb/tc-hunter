import { getProfile } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Flash, ProfileNav } from "@/components/profile/Fact";
import { AddForm, Item, ProfileSection } from "@/components/profile/Section";
import { TopBar } from "@/components/TopBar";
import { CATEGORY_LABELS, flashOf, PROFICIENCY_LABELS, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { addEvidenceAction, removeEvidenceAction } from "../actions";

export const dynamic = "force-dynamic";

/**
 * Skills (brief 5.1): grouped by kind. A skill counts in matching only with
 * proof: something you did that shows it. The level is always yours to set.
 */
export default async function SkillsPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error }, profile] = await Promise.all([flashOf(props), getProfile(pool, cfg, session)]);
  const back = "/profile/skills";
  const proofOptions: Array<[string, string]> = [
    ...profile.experience.flatMap((e) => [
      [`experience_item:${e.id}`, `${e.title}${e.employer_name ? `, ${e.employer_name}` : ""}`] as [string, string],
      ...e.bullets.map((b) => [`experience_bullet:${b.id}`, `  · ${String(b.text).slice(0, 90)}`] as [string, string]),
    ]),
    ...profile.education.map((ed) => [`education_item:${ed.id}`, `${ed.institution}${ed.degree ? `, ${ed.degree}` : ""}`] as [string, string]),
    ...profile.credentials.map((c) => [`credential:${c.id}`, c.name] as [string, string]),
  ];
  const noProof = profile.skills.filter((s) => s.evidence.length === 0);

  return (
    <>
      <TopBar signedIn />
      <h1>{t("profile.skills.title")}</h1>
      <ProfileNav current={back} />
      <Flash saved={saved} error={error} />
      {noProof.length ? (
        <p id="no-proof" className="status">{noProof.length} {noProof.length === 1 ? "skill has" : "skills have"} no proof yet. Link each to something you did so it counts in matching.</p>
      ) : null}

      <ProfileSection title="Skills" addTitle="Add a skill" addForm={<AddForm table="skill" back={back} />}
        empty={profile.skills.length ? undefined : "No skills yet. Use the plus to add one."}>
        {CATEGORY_LABELS.map(([cat, label]) => {
          const list = profile.skills.filter((s) => s.category === cat);
          if (!list.length) return null;
          return (
            <div key={cat} className="skill-group">
              <h3 className="group-label">{label}</h3>
              {list.map((s) => (
                <Item key={s.id} table="skill" row={s} back={back} title={s.canonical_name} editTitle={`Edit ${s.canonical_name}`}
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
              ))}
            </div>
          );
        })}
      </ProfileSection>
    </>
  );
}
