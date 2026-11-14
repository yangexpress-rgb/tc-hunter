import type { DigestOutcome, DigestView } from "@tc-hunter/db";
import type { ProfileDuplicate } from "@tc-hunter/domain";

/** Plain names for each step of reading a stored resume into the profile. */
export const DIGEST_STEPS: Array<[string, string]> = [
  ["queued", "Saved your original file"],
  ["reading", "Getting the text out of the file"],
  ["sorting", "Sorting it into sections"],
  ["parsing", "Reading each section"],
  ["matching", "Checking against what's already in your profile"],
  ["saving", "Saving drafts for you to check"],
  ["ready", "Ready for you to check"],
];

export const STATUS_LABELS: Record<string, string> = {
  queued: "Waiting to be read", reading: "Reading", sorting: "Reading", parsing: "Reading", matching: "Checking for duplicates",
  saving: "Saving drafts", ready: "Read", failed: "Couldn't read", replaced: "Read again since",
};

export const fileSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function DigestChip({ digest }: { digest: DigestView | null }) {
  if (!digest) return <span className="chip draft">Not read yet</span>;
  if (digest.stuck) return <span className="chip draft">Stopped part-way</span>;
  const s = digest.summary;
  const label = digest.status === "ready"
    ? `${(s.add ?? 0) + (s.similar ?? 0)} new${s.same ? `, ${s.same} already there` : ""}${s.similar ? `, ${s.similar} to compare` : ""}`
    : STATUS_LABELS[digest.status] ?? digest.status;
  return <span className={`chip ${digest.status === "ready" ? "ok" : "draft"}`}>{label}</span>;
}

/** The step list, with what each step found. The current step is marked while it runs. */
export function DigestProgress({ digest }: { digest: DigestView }) {
  const seen = new Map(digest.steps.map((s) => [s.step, s]));
  const failed = digest.status === "failed" || digest.stuck;
  const running = !failed && !["ready", "replaced"].includes(digest.status);
  return (
    <ol className="digest-steps">
      {DIGEST_STEPS.map(([key, label], i) => {
        const rec = seen.get(key);
        if (!rec) return failed ? null : <li key={key} className="todo">{label}</li>;
        const current = running && key === digest.status;
        // Each step's record says what the step before it found; queued and ready describe themselves.
        const next = DIGEST_STEPS[i + 1]?.[0];
        const detail = key === "queued" || key === "ready" ? rec.detail : next && next !== "ready" ? seen.get(next)?.detail : "";
        return (
          <li key={key} className={current ? "now" : "done"} aria-current={current ? "step" : undefined}>
            <span>{label}{current ? "…" : ""}</span>
            {detail ? <span className="muted"> · {detail}</span> : null}
          </li>
        );
      })}
      {failed ? <li className="failed">{digest.stuck ? "Stopped part-way. Use Re-scan to read it again." : seen.get("failed")?.detail ?? digest.error}</li> : null}
    </ol>
  );
}

const KIND_LABELS: Record<DigestOutcome["kind"], string> = {
  experience: "Role", bullet: "Bullet", education: "School", skill: "Skill", credential: "Certification", award: "Award",
};

export function OutcomeList({ items }: { items: DigestOutcome[] }) {
  return (
    <ul className="outcomes">
      {items.map((o, i) => (
        <li key={i}>
          <span className="muted">{KIND_LABELS[o.kind]}:</span> {o.label}
          {o.under ? <span className="muted"> (under {o.under})</span> : null}
          {o.match ? (
            <div className="muted small">
              {o.decision === "same" ? "Already there as" : "Looks like"} “{o.match.label}”
              {o.match.checked ? ", which you've checked" : o.match.fromFile ? `, waiting for your check from ${o.match.fromFile}` : ""}
              {o.reason ? ` (${o.reason.toLowerCase()})` : ""}
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

const DUP_KIND: Record<ProfileDuplicate["kind"], string> = {
  experience: "Role", bullet: "Bullet", education: "School", skill: "Skill", credential: "Certification", award: "Award",
};

/** Copies already in the profile (mostly from earlier uploads), with one button to remove the extra ones. */
export function DuplicateBanner({ dups, back, action }: { dups: ProfileDuplicate[]; back: string; action: (form: FormData) => Promise<void> }) {
  if (!dups.length) return null;
  return (
    <section className="card dup-banner">
      <p className="status">{dups.length} {dups.length === 1 ? "row is a copy" : "rows are copies"} of something already in your profile, most likely from uploading a resume more than once.</p>
      <form action={action}>
        <input type="hidden" name="back" value={back} />
        <button className="small">Remove the extra copies</button>
      </form>
      <p className="muted">Only rows you haven't checked are removed. If a copied role has bullets the other one doesn't, they're moved over, not lost.</p>
      <details className="layer2">
        <summary>See the copies</summary>
        <ul className="outcomes">
          {dups.map((d) => (
            <li key={d.id}>
              <span className="muted">{DUP_KIND[d.kind]}:</span> {d.label}
              {d.moveBulletIds?.length ? <span className="muted"> ({d.moveBulletIds.length} of its bullets will move over)</span> : null}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}
