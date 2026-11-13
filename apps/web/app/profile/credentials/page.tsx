import { getProfile } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { Flash, ProfileNav } from "@/components/profile/Fact";
import { FactList } from "@/components/profile/FactList";
import { TopBar } from "@/components/TopBar";
import { flashOf, showMonth, type PageProps } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

const KIND: Record<string, string> = { certification: "Certification", licence: "Licence", clearance: "Clearance" };

export default async function CredentialsPage(props: PageProps) {
  const session = await requireSession();
  const { pool, cfg } = app();
  const [{ saved, error }, profile] = await Promise.all([flashOf(props), getProfile(pool, cfg, session)]);
  return (
    <>
      <TopBar signedIn />
      <h1>{t("profile.credentials.title")}</h1>
      <ProfileNav current="/profile/credentials" />
      <Flash saved={saved} error={error} />
      <FactList table="credential" rows={profile.credentials} back="/profile/credentials" addLabel="Add a certification or licence"
        title={(r) => r.name}
        describe={(r) => [KIND[r.kind], r.issuer, r.issued_on ? `issued ${showMonth(r.issued_on)}` : null, r.expires_on ? `expires ${showMonth(r.expires_on)}` : null].filter(Boolean).join(" · ")} />
    </>
  );
}
