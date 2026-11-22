import { coachNudges, fillAboutFromResume, getProfile, listGoals, listResumeFiles, profileDuplicates, resumeReaderName } from "@tc-hunter/db";
import { ABOUT_GUIDE, activeAiProvider, aiIsOff, ClaudeAboutFinder, docCopy, t, type AiMode } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash, ProfileNav } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { AwardsSection, CertificationsSection, EducationSection, ExperienceSections, LanguagesSection, SkillsSection } from "@/components/profile/sections";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { EditDialog } from "@/components/profile/EditDialog";
import { fillAboutAction, saveAboutAction, saveSummaryAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * My Profile (brief 6.2): about you, with the Evidence Coach's to-do list on top,
 * then experience, education, certifications, skills and awards as sections on one page.
 */
export default async function ProfilePage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  // An empty About fills itself from the uploaded resume, once per file (Yong, 2026-11-17: "I have content in my initial resume").
  try {
    await fillAboutFromResume(pool, cfg, session, { finder: resumeReaderName() === "claude" && !(await aiIsOff()) ? new ClaudeAboutFinder() : undefined });
  } catch { /* the page still shows; the button below tries again */ }
  const [{ saved, error, params }, profile, nudges, goals, copies, files] = await Promise.all([flashOf(props), getProfile(pool, cfg, session), coachNudges(pool, session),
    listGoals(pool, session), profileDuplicates(pool, session), listResumeFiles(pool, session)]);
  const targets: string[] = [...new Set(goals.flatMap((g) => g.roles))];
  const mode = await activeAiProvider();
  const a = profile.about;
  return (
    <>
      <TopBar signedIn />
      <h1>{t("profile.title")}</h1>
      <ProfileNav current="/profile" />
      <Flash saved={saved} error={error} />

      {nudges.length ? (
        <section className="card coach" aria-label={t("home.coach.title")}>
          <h2>{t("home.coach.title")}</h2>
          <ul>{nudges.map((n) => <li key={n.key}><a href={n.href}>{n.text}</a></li>)}</ul>
        </section>
      ) : null}

      <AboutSection text={a.summary} source={a.summarySource} hasResume={files.length > 0} mode={mode} />

      <section className="card" id="details">
        <h2>Contact and basics</h2>
        <form action={saveAboutAction} className="fields">
          <input type="hidden" name="back" value="/profile" />
          <label>Name we call you<input name="preferredName" defaultValue={a.preferredName} required /></label>
          <label>Full legal name<input name="legalName" defaultValue={a.legalName} autoComplete="name" /></label>
          <label>Email for applications<input name="email" type="email" defaultValue={a.email} /></label>
          <label>Phone<input name="phone" type="tel" defaultValue={a.phone} autoComplete="tel" /></label>
          <label>City<input name="city" defaultValue={a.city} /></label>
          <label>State or region<input name="region" defaultValue={a.region} /></label>
          <label>Country<input name="country" defaultValue={a.country} /></label>
          <label>Time zone<input name="timezone" defaultValue={a.timezone} placeholder="America/New_York" /></label>
          <label>LinkedIn<input name="linkedin" defaultValue={a.links.linkedin ?? ""} /></label>
          <label>Portfolio<input name="portfolio" defaultValue={a.links.portfolio ?? ""} /></label>
          <label>GitHub<input name="github" defaultValue={a.links.github ?? ""} /></label>
          <label>
            Work authorisation, in your words
            <textarea name="workAuthSummary" defaultValue={a.workAuthSummary} rows={2} />
            <span className="hint">Kept for your reference. We never answer work authorisation questions for you.</span>
          </label>
          <div><button type="submit">Save</button></div>
        </form>
      </section>

      <ExperienceSections profile={profile} targets={targets} sort={params.sort} copies={copies} />
      <EducationSection profile={profile} />
      <CertificationsSection profile={profile} />
      <SkillsSection profile={profile} />
      <LanguagesSection profile={profile} />
      <AwardsSection profile={profile} />

      <Details summary="How your information is kept">
        <p>{t("settings.privacy")}</p>
        <p>Your name, contact details, About and work authorisation are stored locked with a key that belongs to you alone.</p>
      </Details>
      <Advanced>
        <AdvancedRow label="Imports" value={String(profile.imports.length)} />
        <AdvancedRow label="Encrypted fields" value="legal name, email, phone, work authorisation, About" />
      </Advanced>
    </>
  );
}

const SOURCE_NOTE: Record<string, string> = {
  resume: "Copied word for word from your uploaded resume. Edit it to make it yours.",
  linkedin: "Copied word for word from your LinkedIn file. Edit it to make it yours.",
};

/**
 * About (Yong, 2026-11-17), as on LinkedIn: a short executive summary of who you are, the value
 * you bring and your main experience. Each tailored resume opens with a version of it written
 * for that job, from your profile's facts only.
 */
function AboutSection({ text, source, hasResume, mode }: { text: string; source: string | null; hasResume: boolean; mode: AiMode }) {
  const copy = docCopy(mode);
  const paragraphs = text.split(/\n+/).filter((p) => p.trim());
  return (
    <section className="card profile-section" id="about">
      <header className="section-head">
        <h2>About</h2>
        <EditDialog icon="pencil" label="Edit About" title="Edit About">
          <form action={saveSummaryAction} className="stack">
            <input type="hidden" name="back" value="/profile#about" />
            <label>About
              <textarea name="summary" rows={12} maxLength={2600} defaultValue={text}
                placeholder="Senior technology leader with 20 years in digital transformation and IT delivery at global companies. Known for…" />
            </label>
            <p className="hint">A few sentences in business language: who you are (your level, field and the scale you work at), the value you bring,
              and your main experience and expertise, with a result or two. Up to 2,600 characters, like LinkedIn.{" "}
              {mode === "none" ? "Each tailored resume starts with it as you wrote it." : "Each tailored resume starts with a version of this written for that job, using only what your profile says."}</p>
            <button>Save</button>
          </form>
          {mode === "none" ? <p className="hint">{copy.summaryNote}</p> : (
            <Details summary={copy.summaryHow}>
              <pre className="prompt-text" style={{ whiteSpace: "pre-wrap" }}>{ABOUT_GUIDE}</pre>
            </Details>
          )}
        </EditDialog>
      </header>
      {paragraphs.length ? (
        <>
          {paragraphs.map((p, i) => <p key={i}>{p}</p>)}
          {source && SOURCE_NOTE[source] ? <p className="muted small">{SOURCE_NOTE[source]}</p> : null}
          <p className="muted small">{copy.summaryNote}</p>
        </>
      ) : (
        <>
          <p className="muted">No About yet. Write a short summary of who you are, the value you bring and your main experience, using the pencil.</p>
          {hasResume ? (
            <form action={fillAboutAction}>
              <input type="hidden" name="back" value="/profile#about" />
              <button className="secondary">Copy the summary from my resume</button>
            </form>
          ) : null}
        </>
      )}
    </section>
  );
}
