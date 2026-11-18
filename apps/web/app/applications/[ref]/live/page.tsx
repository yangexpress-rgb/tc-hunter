import { notFound, redirect } from "next/navigation";
import { getApplication, openHandover } from "@tc-hunter/db";
import { TopBar } from "@/components/TopBar";
import { LiveView } from "@/components/applications/LiveView";
import { app, requireSession } from "@/lib/server";
import { liveOn } from "@/lib/live";
import { giveUpAction, handBackAction } from "../../actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ ref: string }> };

/**
 * "Your turn" (Yong, 2026-11-17): the employer's page as TC Hunter's browser holds it, live. The applicant
 * does the one step there (ticks the box, signs in, makes the statement), then hands it back. Only from
 * inside their own signed-in session; it closes when the step's window ends or TC Hunter takes over again.
 */
export default async function LivePage(props: Props) {
  const session = await requireSession();
  const { ref } = await props.params;
  if (!/^A-\d{1,12}$/.test(ref)) notFound();
  const { pool, cfg } = app();
  const a = await getApplication(pool, cfg, session, ref);
  if (!a) notFound();
  const h = liveOn() ? await openHandover(pool, session, ref) : null;
  if (!h) redirect(`/applications/${ref}#applying`);
  return (
    <>
      <TopBar signedIn />
      <p><a href={`/applications/${ref}`}>← {a.title}</a></p>
      <h1>Your turn — finish this step</h1>
      <p className="status">{h.what}</p>
      <p className="muted">Do just this step on their page below. TC Hunter is holding the page and won&apos;t touch it while it&apos;s your turn.
        {h.phase === "before_submit" ? " Don't press their Submit button: TC Hunter does that after you hand back, once you've approved sending." : ""}
        {" "}This step waits until {h.until}.</p>
      <LiveView appRef={ref} />
      <div className="inline-actions">
        <form action={handBackAction}>
          <input type="hidden" name="app" value={ref} /><input type="hidden" name="back" value={`/applications/${ref}#applying`} />
          <button>I&apos;m done — hand back</button>
        </form>
        <form action={giveUpAction}>
          <input type="hidden" name="app" value={ref} /><input type="hidden" name="back" value={`/applications/${ref}#applying`} />
          <button className="secondary">I can&apos;t do it here</button>
        </form>
      </div>
      <p className="muted small">If their page moves on by itself once you&apos;re done, TC Hunter notices and takes over. &quot;I can&apos;t do it here&quot; closes their page; you can then finish on their site with your packet one tap away.</p>
    </>
  );
}
