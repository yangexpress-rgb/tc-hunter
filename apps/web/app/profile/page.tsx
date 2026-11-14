import { coachNudges, getProfile, listGoals, profileDuplicates } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash, ProfileNav } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { AwardsSection, CertificationsSection, EducationSection, ExperienceSections, SkillsSection } from "@/components/profile/sections";
import { flashOf, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { saveAboutAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * My Profile (brief 6.2): about you, with the Evidence Coach's to-do list on top,
 * then experience, education, certifications, skills and awards as sections on one page.
 */
export default async function ProfilePage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error, params }, profile, nudges, goals, copies] = await Promise.all([flashOf(props), getProfile(pool, cfg, session), coachNudges(pool, session),
    listGoals(pool, session), profileDuplicates(pool, session)]);
  const targets: string[] = [...new Set(goals.flatMap((g) => g.roles))];
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

      <section className="card" id="about">
        <h2>About you</h2>
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
      <AwardsSection profile={profile} />

      <Details summary="How your information is kept">
        <p>{t("settings.privacy")}</p>
        <p>Your name, contact details and work authorisation are stored locked with a key that belongs to you alone.</p>
      </Details>
      <Advanced>
        <AdvancedRow label="Imports" value={String(profile.imports.length)} />
        <AdvancedRow label="Encrypted fields" value="legal name, email, phone, work authorisation" />
      </Advanced>
    </>
  );
}
