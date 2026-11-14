import type { EmailSignalRow } from "@tc-hunter/db";
import { gmailLink, STAGE_LABEL } from "@tc-hunter/domain";
import { emailSignalAction } from "@/app/applications/actions";

const SAYS: Record<string, string> = {
  acknowledgement: "confirmed they received your application",
  interview: "invited you to an interview",
  offer: "made you an offer",
  rejection: "said they're not moving forward",
};

/** Suggestions from connected email. Never applied by themselves: the applicant says yes or no. */
export function EmailSuggestions({ rows, back, timeZone, showJob = true }: { rows: EmailSignalRow[]; back: string; timeZone: string; showJob?: boolean }) {
  if (!rows.length) return null;
  const day = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" }).format(new Date(d));
  return (
    <section className="card email-suggestions" aria-label="From your email">
      <h2>From your email</h2>
      <ul className="plain">
        {rows.map((r) => (
          <li key={r.id} className="suggestion">
            <p>It looks like <strong>{r.employer}</strong> {SAYS[r.kind]}{showJob ? <> about <a href={`/applications/${r.appRef}`}>{r.title}</a></> : null}.
              <span className="muted"> Email from {r.senderDomain}, {day(r.receivedAt)}. <a href={gmailLink(r.messageId)} target="_blank" rel="noopener noreferrer">Open it in Gmail</a></span></p>
            <div className="inline-actions">
              <form action={emailSignalAction}>
                <input type="hidden" name="signal" value={r.id} /><input type="hidden" name="back" value={back} />
                <button>Yes, move it to {STAGE_LABEL[r.suggestedStage]}</button>
              </form>
              <form action={emailSignalAction}>
                <input type="hidden" name="signal" value={r.id} /><input type="hidden" name="back" value={back} /><input type="hidden" name="do" value="dismiss" />
                <button className="secondary">Not right</button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
