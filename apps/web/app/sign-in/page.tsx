import { t } from "@tc-hunter/domain";
import { TopBar } from "@/components/TopBar";
import { SignInWithPasskey } from "@/components/profile/PasskeyButtons";
import { passkeysAvailable } from "@tc-hunter/db";
import { app } from "@/lib/server";
import { SignInForm } from "./SignInForm";

export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams;
  const { cfg } = app();
  return (
    <>
      <TopBar signedIn={false} />
      <div className="card">
        <h1>{t("signin.title")}</h1>
        {sp.erased ? <p className="status" role="status">Your account and everything in it have been deleted.</p> : null}
        <SignInForm labels={{ email: "Email", password: "Password", cta: t("signin.cta") }} />
        {passkeysAvailable(cfg) ? <SignInWithPasskey text={{ cta: t("signin.passkey_cta"), failed: t("signin.passkey_failed") }} /> : null}
        <p className="muted">New here? <a href="/sign-up">{t("signup.title")}</a></p>
      </div>
    </>
  );
}
