import { getProfile } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Chip, FactFields, Flash, ProfileNav, RowRef } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { CATEGORY_LABELS, FIELD_SPECS, flashOf, pct, PROFICIENCY_LABELS, SOURCE_LABELS, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { addEvidenceAction, addFactAction, deleteFactAction, removeEvidenceAction, updateFactAction, verifyFactAction } from "../actions";

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

      {CATEGORY_LABELS.map(([cat, label]) => {
        const list = profile.skills.filter((s) => s.category === cat);
        if (!list.length) return null;
        return (
          <section key={cat}>
            <h2>{label}</h2>
            {list.map((s) => (
              <article className="card fact" key={s.id}>
                <header className="fact-head">
                  <div>
                    <h3>{s.canonical_name}</h3>
                    <p className="muted">
                      {s.proficiency ? `${PROFICIENCY_LABELS.find(([k]) => k === s.proficiency)?.[1]} (${s.proficiency_set_by === "import_as_stated" ? "as your resume says" : "your call"})` : "Level not set"}
                      {s.evidence.length ? ` · ${s.evidence.length} proof` : ""}
                    </p>
                  </div>
                  <Chip checked={s.verification === "verified"} />
                </header>
                {s.evidence.length === 0 ? <p className="hint">{t("profile.skills.no_proof")}</p> : (
                  <ul className="bullets">
                    {s.evidence.map((ev) => (
                      <li key={ev.id}>{ev.label}
                        <form action={removeEvidenceAction} className="inline"><input type="hidden" name="back" value={back} /><input type="hidden" name="evidence_id" value={ev.id} /><button className="small secondary">Unlink</button></form>
                      </li>
                    ))}
                  </ul>
                )}
                {proofOptions.length ? (
                  <form action={addEvidenceAction} className="inline-form">
                    <input type="hidden" name="back" value={back} /><input type="hidden" name="skill_id" value={s.id} />
                    <label>Shown by<select name="target" required defaultValue=""><option value="" disabled>Pick something you did</option>{proofOptions.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></label>
                    <button className="small">Link proof</button>
                  </form>
                ) : null}
                <div className="row-actions">
                  {s.verification !== "verified" ? (
                    <form action={verifyFactAction}><RowRef table="skill" id={s.id} back={back} /><button className="small">{t("profile.check_cta")}</button></form>
                  ) : null}
                </div>
                <Details summary="Edit or remove">
                  <p className="muted">{SOURCE_LABELS[s.source]}{pct(s.parse_confidence) ? ` · we're ${pct(s.parse_confidence)} sure we read this right` : ""}</p>
                  <form action={updateFactAction}><RowRef table="skill" id={s.id} back={back} /><FactFields spec={FIELD_SPECS.skill} values={s} /><button className="small">Save</button></form>
                  <form action={deleteFactAction}><RowRef table="skill" id={s.id} back={back} /><button className="small secondary">Remove</button></form>
                </Details>
              </article>
            ))}
          </section>
        );
      })}

      <section className="card">
        <h2>Add a skill</h2>
        <form action={addFactAction}><RowRef table="skill" back={back} /><FactFields spec={FIELD_SPECS.skill} /><button>Add</button></form>
      </section>
    </>
  );
}
