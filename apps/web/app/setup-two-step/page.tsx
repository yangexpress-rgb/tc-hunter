import { redirect } from "next/navigation";
import { t } from "@tc-hunter/domain";
import { TopBar } from "@/components/TopBar";
import { requireSessionForSetup } from "@/lib/server";
import { MfaSetup } from "../settings/MfaSetup";
import { signOutAction } from "../settings/actions";

export const dynamic = "force-dynamic";

/** Where a new (or not yet protected) account lands: two-step sign-in comes before anything else. */
export default async function SetupTwoStepPage() {
  const session = await requireSessionForSetup();
  if (session.mfaEnabled) redirect("/");
  return (
    <>
      <TopBar signedIn={false} />
      <div className="card">
        <h1>{t("settings.mfa.required_title")}</h1>
        <p>{t("settings.mfa.required")}</p>
        <MfaSetup next="/" text={{
          setup: t("settings.mfa.setup"), enable: t("settings.mfa.enable_cta"), confirm: t("settings.mfa.confirm_cta"),
          on: t("settings.mfa.on"), codesIntro: t("settings.mfa.codes_intro"), codesSaved: t("settings.mfa.codes_saved"),
        }} />
        <form action={signOutAction} style={{ marginTop: 24 }}>
          <button type="submit" className="secondary small">{t("signout.cta")}</button>
        </form>
      </div>
    </>
  );
}
