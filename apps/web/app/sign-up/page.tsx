import { t } from "@tc-hunter/domain";
import { TopBar } from "@/components/TopBar";
import { app } from "@/lib/server";
import { SignUpForm } from "./SignUpForm";

export const dynamic = "force-dynamic";

export default async function SignUpPage({ searchParams }: { searchParams: Promise<{ invite?: string | string[] }> }) {
  const { cfg } = app();
  const raw = (await searchParams).invite;
  const invite = (Array.isArray(raw) ? raw[0] : raw)?.trim().slice(0, 40) || undefined;
  // Invitations work even where open sign-up is closed (brief 2026-11-25).
  const inviteOnly = !cfg.allowSignup;
  const codeLabel = invite || inviteOnly ? t("signup.invite_label") : cfg.signupCode ? "Sign-up code (from the person who runs TC Hunter)" : null;
  return (
    <>
      <TopBar signedIn={false} />
      <div className="card">
        <h1>{t("signup.title")}</h1>
        {inviteOnly && !invite ? <p>{t("signup.invite_only")}</p> : null}
        <p className="muted">{t("settings.privacy")}</p>
        <SignUpForm cta={t("signup.cta")} codeLabel={codeLabel} invite={invite} hint={invite || inviteOnly ? t("signup.invite_hint") : undefined} />
        <p className="muted">Already have an account? <a href="/sign-in">{t("signin.title")}</a></p>
      </div>
    </>
  );
}
