import { BRAND, t } from "@tc-hunter/domain/messages";
import { AppNav } from "@/components/AppNav";
import { signOutAction } from "@/app/settings/actions";
import { currentSession } from "@/lib/server";

export async function TopBar({ signedIn }: { signedIn: boolean }) {
  if (signedIn) {
    // Admin-only tabs (People) show only for an admin; the page and the database check again.
    const isAdmin = (await currentSession().catch(() => null))?.isAdmin ?? false;
    return (
      <AppNav brand={BRAND.name} tagline={BRAND.tagline} isAdmin={isAdmin} footer={
        <form action={signOutAction}><button type="submit" className="link">{t("signout.cta")}</button></form>
      } />
    );
  }
  return (
    <header className="top">
      <div>
        <a className="brand" href="/">{BRAND.name}</a>
        <span className="tagline">{BRAND.tagline}</span>
      </div>
    </header>
  );
}
