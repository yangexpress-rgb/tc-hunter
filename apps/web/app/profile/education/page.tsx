import { getProfile } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Flash, ProfileNav } from "@/components/profile/Fact";
import { FactList } from "@/components/profile/FactList";
import { TopBar } from "@/components/TopBar";
import { flashOf, showMonth, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

export default async function EducationPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error }, profile] = await Promise.all([flashOf(props), getProfile(pool, cfg, session)]);
  return (
    <>
      <TopBar signedIn />
      <h1>{t("profile.education.title")}</h1>
      <ProfileNav current="/profile/education" />
      <Flash saved={saved} error={error} />
      <FactList table="education_item" rows={profile.education} back="/profile/education" addLabel="Add education"
        title={(r) => r.institution}
        describe={(r) => [r.degree, r.field].filter(Boolean).join(", ") + (r.end_date ? ` · ${showMonth(r.end_date)}` : "") + (r.honours ? ` · ${r.honours}` : "")} />
    </>
  );
}
