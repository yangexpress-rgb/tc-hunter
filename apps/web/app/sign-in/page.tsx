import { t } from "@tc-hunter/domain";
import { TopBar } from "@/components/TopBar";
import { SignInForm } from "./SignInForm";

export const dynamic = "force-dynamic";

export default function SignInPage() {
  return (
    <>
      <TopBar signedIn={false} />
      <div className="card">
        <h1>{t("signin.title")}</h1>
        <SignInForm labels={{ email: "Email", password: "Password", cta: t("signin.cta") }} />
        <p className="muted">New here? <a href="/sign-up">{t("signup.title")}</a></p>
      </div>
    </>
  );
}
