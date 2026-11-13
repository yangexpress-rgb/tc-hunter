import { t } from "@tc-hunter/domain";
import { TopBar } from "@/components/TopBar";
import { CodeForm } from "./CodeForm";

export const dynamic = "force-dynamic";

export default function CodePage() {
  return (
    <>
      <TopBar signedIn={false} />
      <div className="card">
        <h1>{t("signin.title")}</h1>
        <p>{t("signin.code_prompt")}</p>
        <CodeForm cta={t("signin.cta")} />
      </div>
    </>
  );
}
