import { BRAND, t } from "@tc-hunter/domain/messages";
import { AppNav } from "@/components/AppNav";
import { signOutAction } from "@/app/settings/actions";

export function TopBar({ signedIn }: { signedIn: boolean }) {
  if (signedIn) {
    return (
      <AppNav brand={BRAND.name} tagline={BRAND.tagline} footer={
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
