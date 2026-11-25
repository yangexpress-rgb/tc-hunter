import { passwordResetFor } from "@tc-hunter/db";
import { t } from "@tc-hunter/domain";
import { TopBar } from "@/components/TopBar";
import { app } from "@/lib/server";
import { ResetForm } from "./ResetForm";

export const dynamic = "force-dynamic";

/** A password reset link from the person who runs TC Hunter (brief 2026-11-25, Stage 3). Works once, for 24 hours. */
export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ code?: string | string[] }> }) {
  const raw = (await searchParams).code;
  const code = (Array.isArray(raw) ? raw[0] : raw) ?? "";
  const email = await passwordResetFor(app().pool, code);
  return (
    <>
      <TopBar signedIn={false} />
      <div className="card">
        <h1>{t("reset.title")}</h1>
        {email ? (
          <>
            <p>For <strong>{email}</strong>. Your old password stops working once you save this one, and you&apos;ll be signed out everywhere.</p>
            <ResetForm code={code} email={email} cta={t("reset.cta")} />
          </>
        ) : <p className="error">{t("reset.bad_link")}</p>}
        <p className="muted"><a href="/sign-in">{t("signin.title")}</a></p>
      </div>
    </>
  );
}
