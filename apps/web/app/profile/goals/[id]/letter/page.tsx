import { notFound } from "next/navigation";
import { getDocument, listGoals, listStandardDocuments } from "@tc-hunter/db";
import { goalLabel } from "@tc-hunter/domain";
import { Flash } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { flashOf } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { standardLetterAction } from "@/app/documents/actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/**
 * A goal's standard cover letter (Yong, 2026-11-24): paste or type it, or upload the file. Kept in the
 * applicant's words. Every new application under the goal starts with a copy, with [Company] and [Job title]
 * filled in for that job, for them to revise and approve.
 */
export default async function StandardLetterPage(props: Props) {
  const session = await requireSession();
  const { id } = await props.params;
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { pool, cfg } = app();
  const [{ error }, goals, standards] = await Promise.all([flashOf(props), listGoals(pool, session), listStandardDocuments(pool, session)]);
  const goal = goals.find((g) => g.id === id);
  if (!goal) notFound();
  const current = standards.find((d) => d.goalId === id && d.kind === "letter");
  const doc = current ? await getDocument(pool, cfg, session, current.ref) : null;
  const text = doc && doc.source.kind === "letter" ? doc.source.paragraphs.filter((p) => p.included).map((p) => p.text).join("\n\n") : "";

  return (
    <>
      <TopBar signedIn />
      <p><a href={`/profile/goals#goal-${goal.id}`}>← Back to your goals</a></p>
      <h1>Standard cover letter for {goalLabel(goal)}</h1>
      <Flash error={error} />
      <p>Every new application under this goal starts with a copy of this letter, ready for you to revise for that job and approve.</p>
      {current ? <p className="muted">This replaces the standard letter this goal has now (<a href={`/documents/${current.ref}`}>open it</a>). Letters already made for jobs stay as they are.</p> : null}
      <section className="card own-letter">
        <form action={standardLetterAction} className="stack">
          <input type="hidden" name="goal" value={goal.id} />
          <label>Paste or write your letter
            <textarea name="text" rows={16} defaultValue={text} placeholder={"I'm excited to apply for the [Job title] role at [Company].\n\nIn my current role I..."} />
          </label>
          <label>Or upload it<input type="file" name="file" accept=".pdf,.docx,.txt,.md" /></label>
          <p className="hint">Write <strong>[Company]</strong> and <strong>[Job title]</strong> where each job&apos;s company and title should go, and they&apos;re filled in for every application.
            Just the body is enough: TC Hunter adds the date, &ldquo;Dear (company) hiring team,&rdquo; and your name at the end, so a greeting or sign-off in your text is left off.
            Your words are kept exactly as written. If you upload a file, its text is used instead of anything pasted above.</p>
          <button>Save as this goal&apos;s standard letter</button>
        </form>
      </section>
      <p className="muted">Saving it sends nothing anywhere. No AI is used.</p>
    </>
  );
}
