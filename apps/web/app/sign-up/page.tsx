import { t } from "@tc-hunter/domain";
import { TopBar } from "@/components/TopBar";
import { app } from "@/lib/server";
import { SignUpForm } from "./SignUpForm";

export const dynamic = "force-dynamic";

export default function SignUpPage() {
  const { cfg } = app();
  return (
    <>
      <TopBar signedIn={false} />
      <div className="card">
        <h1>{t("signup.title")}</h1>
        {cfg.allowSignup ? (
          <>
            <p className="muted">{t("settings.privacy")}</p>
            <SignUpForm cta={t("signup.cta")} />
          </>
        ) : (
          <p>{t("signup.closed")}</p>
        )}
        <p className="muted">Already have an account? <a href="/sign-in">{t("signin.title")}</a></p>
      </div>
    </>
  );
}
