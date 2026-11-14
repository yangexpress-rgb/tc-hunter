import { BRAND, t } from "@tc-hunter/domain/messages";

export function TopBar({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="top">
      <div>
        <a className="brand" href="/">{BRAND.name}</a>
        <span className="tagline">{BRAND.tagline}</span>
      </div>
      {signedIn ? (
        <nav>
          <a href="/">Home</a>
          <a href="/jobs">{t("jobs.title")}</a>
          <a href="/profile">{t("profile.title")}</a>
          <a href="/settings">{t("settings.title")}</a>
        </nav>
      ) : null}
    </header>
  );
}
