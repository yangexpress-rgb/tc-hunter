import { notFound } from "next/navigation";
import { getMatchByRef, getPreferences, listApplications, listDocuments, tailorWork } from "@tc-hunter/db";
import { STAGE_LABEL, t, type ApplicationStage } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash } from "@/components/profile/Fact";
import { FeedbackButtons, ScoreBadge, ago, pay, place, posted } from "@/components/jobs/JobBits";
import { TopBar } from "@/components/TopBar";
import { flashOf } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { tailorAction } from "@/app/documents/actions";
import { trackAction } from "@/app/applications/actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const EVENT_TEXT: Record<string, string> = {
  closed: "The job closed",
  requirements_changed: "The requirements changed",
  description_changed: "The description changed",
  reposted: "The job was posted again",
};

/** One job (brief 5.3): Layer 1 is the score, the reason, the career step and what to do; the working-out is one click away. */
export default async function JobPage(props: Props) {
  const session = await requireSession();
  const { ref } = await props.params;
  if (!/^[A-Za-z0-9-]{1,40}$/.test(ref)) notFound();
  const { pool } = app();
  const [{ saved, error, params }, m] = await Promise.all([flashOf(props), getMatchByRef(pool, session, ref)]);
  if (!m) notFound();
  const [docs, work, prefs, apps] = await Promise.all([listDocuments(pool, session, m.public_ref), tailorWork(pool, session, m.public_ref), getPreferences(pool, session), listApplications(pool, session)]);
  const tracked = apps.find((a) => a.job_ref === m.public_ref);
  const preparing = work && (work.status === "queued" || work.status === "running");
  const minScore = prefs?.min_score_to_tailor ?? null;
  const back = `/jobs/${m.public_ref}`;
  const status = m.status === "saved" ? "saved" : m.status === "new" ? "new" : "passed";
  const comps = (m.components ?? []) as Array<{ key: string; label: string; weight: number; points: number; detail: string[] }>;
  const matched = (m.matched_skills ?? []) as Array<{ skill: string; skillId: string }>;
  const req = (m.requirements ?? {}) as { must_have?: string[]; nice_to_have?: string[]; years?: number | null; education?: string | null; authorisation?: string | null; confidence?: string };
  const adjustments = (m.adjustments ?? []) as Array<{ label: string; delta: number }>;
  const proof = (id: string) => (m.evidence as Array<{ skill_id: string; label: string }>).filter((e) => e.skill_id === id).map((e) => e.label);
  const employerPage = (m.sources as Array<{ url: string; active: boolean }>).find((s) => s.active)?.url ?? m.apply_url;

  return (
    <>
      <TopBar signedIn />
      <p><a href="/jobs">← All jobs</a></p>
      <Flash saved={saved} error={error} />
      <div className="job-head">
        <ScoreBadge score={m.score} filtered={m.filtered} />
        <div>
          <h1>{m.title}</h1>
          <p className="job-meta">{m.employer_canonical} · {place(m)}{pay(m) ? ` · ${pay(m)}` : ""} · {posted(m.posted_at)}</p>
        </div>
      </div>
      {m.posting_status !== "active" ? <p className="error" role="status">{t("jobs.closed")}</p> : null}
      <p className="reason big">{m.reason_line}</p>
      {m.filtered ? <p className="muted">Your preferences rule this one out: {(m.filter_reasons as string[]).join("; ")}.</p> : null}
      {m.ladder_label ? <p><span className={`chip ladder-${m.ladder_tag}`}>{m.ladder_label}</span></p> : null}
      <FeedbackButtons matchId={m.id} status={status} back={back} />
      {preparing ? <meta httpEquiv="refresh" content="4" /> : null}
      {tracked ? (
        <p className="tracked">You're tracking this job: <a href={`/applications/${tracked.public_ref}`}>{STAGE_LABEL[tracked.stage as ApplicationStage]}</a></p>
      ) : (
        <form action={trackAction} className="inline-actions">
          <input type="hidden" name="job" value={m.public_ref} /><input type="hidden" name="back" value={back} />
          <button className="secondary">Track this job</button>
          <span className="hint">Adds it to your applications so you can keep notes and follow-ups.</span>
        </form>
      )}

      <section className="card tailor-card" aria-label="Your resume for this job">
        <h2>Your resume for this job</h2>
        {preparing ? <p className="status" role="status">Preparing your resume and cover letter from your profile. This page updates when they're ready.</p> : null}
        {work?.status === "failed" ? <p className="error" role="alert">We couldn't prepare them this time. Try again.</p> : null}
        {docs.length ? (
          <ul className="plain">
            {docs.sort((a, b) => b.type.localeCompare(a.type)).map((d) => (
              <li key={d.id}><a href={`/documents/${d.public_ref}`}>{d.type === "cover_letter" ? "Cover letter" : "Resume"}, version {d.version}</a>{" "}
                <span className={d.status === "draft" ? "warn" : "muted"}>{d.status === "draft" ? "Draft, waiting for you" : d.status === "approved" ? "Approved" : "Replaced"}</span></li>
            ))}
          </ul>
        ) : null}
        {!preparing && m.posting_status === "active" ? (
          <form action={tailorAction}>
            <input type="hidden" name="job" value={m.public_ref} /><input type="hidden" name="back" value={back} />
            {minScore !== null && m.score < minScore && !docs.length ? <p className="muted">This job scores below the {minScore} you set for preparing resumes.</p> : null}
            <button className={docs.length ? "secondary" : ""}>{docs.length ? "Prepare a fresh draft" : "Prepare a resume for this job"}</button>
            <p className="hint">Built only from rows you've checked. Nothing is sent anywhere.</p>
          </form>
        ) : null}
        {params.preparing === "1" && !preparing && docs.length ? <p className="status" role="status">Ready. Open the draft to look it over.</p> : null}
      </section>

      {(m.gap_skills as string[]).length ? (
        <section className="card">
          <h2>{t("jobs.gaps.title")}</h2>
          <p className="muted">{t("jobs.gaps.hint")}</p>
          <ul>{(m.gap_skills as string[]).map((g) => <li key={g}>{g}</li>)}</ul>
          <p><a href="/profile/skills">Add a skill you have, with proof</a></p>
        </section>
      ) : null}

      <Details summary="How we worked out the score">
        <table className="breakdown">
          <tbody>
            {comps.map((c) => (
              <tr key={c.key}>
                <th scope="row">{c.label}</th>
                <td className="num">{c.points} of {c.weight}</td>
                <td>{c.detail.join(" ")}</td>
              </tr>
            ))}
            {adjustments.map((a) => (
              <tr key={a.label}><th scope="row">Your choices</th><td className="num">{a.delta > 0 ? `+${a.delta}` : a.delta}</td><td>{a.label}</td></tr>
            ))}
          </tbody>
        </table>
        <p className="muted">The career step is shown to help you decide. It doesn't change the score.</p>
      </Details>

      {matched.length ? (
        <Details summary={`Skills you have that this job asks for (${matched.length})`}>
          <ul>
            {matched.map((s) => (
              <li key={s.skillId}><strong>{s.skill}</strong>{proof(s.skillId).length ? <span className="muted"> shown by: {proof(s.skillId).join("; ")}</span> : null}</li>
            ))}
          </ul>
        </Details>
      ) : null}

      <Details summary="What the job asks for">
        {req.must_have?.length ? <><h3>Required</h3><ul>{req.must_have.map((x) => <li key={x}>{x}</li>)}</ul></> : null}
        {req.nice_to_have?.length ? <><h3>Nice to have</h3><ul>{req.nice_to_have.map((x) => <li key={x}>{x}</li>)}</ul></> : null}
        {req.years ? <p>Experience asked for: {req.years}+ years</p> : null}
        {req.education ? <p>Education: {req.education}</p> : null}
        {req.authorisation ? <p>Work permission: {req.authorisation}</p> : null}
        {!req.must_have?.length && !req.nice_to_have?.length ? <p className="muted">We couldn't find a clear list of requirements. Read the full description below.</p> : null}
      </Details>

      <Details summary="Full job description">
        <div className="posting-text">{m.description_text}</div>
        {employerPage ? <p><a href={employerPage} rel="noopener noreferrer" target="_blank">See it on the employer's site</a></p> : null}
      </Details>

      {(m.events as unknown[]).length ? (
        <Details summary="What's changed">
          <ul>{(m.events as Array<{ kind: string; detected_at: string }>).map((e, i) => <li key={i}>{EVENT_TEXT[e.kind] ?? e.kind} <span className="muted">{ago(e.detected_at)}</span></li>)}</ul>
        </Details>
      ) : null}

      <Advanced>
        <AdvancedRow label="Job ref" value={m.public_ref} />
        <AdvancedRow label="ATS type" value={m.ats_type ?? "unknown"} />
        {(m.sources as Array<{ name: string; kind: string; url: string; active: boolean; first_seen_at: string }>).map((s, i) => (
          <AdvancedRow key={i} label={`Source ${i + 1}`} value={`${s.name} (${s.kind}) ${s.url}${s.active ? "" : " [no longer listed]"} first seen ${new Date(s.first_seen_at).toISOString()}`} />
        ))}
        <AdvancedRow label="Found by" value={m.found_by ?? "scan"} />
        <AdvancedRow label="Rules version" value={m.rules_version} />
        <AdvancedRow label="Requirements reader" value={`${m.posting_parser ?? "?"} (confidence ${req.confidence ?? "?"})`} />
        <AdvancedRow label="Computed" value={m.computed_at ? new Date(m.computed_at).toISOString() : "?"} />
        <AdvancedRow label="First / last seen" value={`${new Date(m.first_seen_at).toISOString()} / ${new Date(m.last_seen_at).toISOString()}`} />
        {m.reposted_from ? <AdvancedRow label="Reposted from" value={m.reposted_from} /> : null}
      </Advanced>
    </>
  );
}
