import { notFound } from "next/navigation";
import { applyStatus, getApplication, getMatchByRef, getPreferences, matchFoundJob, journeyFacts, listAdjustments, listApplications, listDocuments, listEmailSignals, listGoals, matchGoals, tailorReadiness, tailorWork, trackerSummary } from "@tc-hunter/db";
import { PASS_REASONS, READ_WITHOUT_AI, aiIsOff, domainLabel, goalLabel, readWithoutAi, t, tierReasonText } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash } from "@/components/profile/Fact";
import { FeedbackButtons, FitScores, ago, pay, place, posted } from "@/components/jobs/JobBits";
import { TopBar } from "@/components/TopBar";
import { flashOf } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { tailorAction } from "@/app/documents/actions";
import { trackAction } from "@/app/applications/actions";
import { isStuck, journeyFor, reachedOf, runLineOf, StatusBlock, Stepper } from "@/components/applications/Journey";
import { DocChecklist } from "@/components/applications/DocChecklist";
import { PostingText } from "@/components/jobs/PostingText";

type FitPart = { key: string; label: string; weight: number; points: number; detail: string[] };

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
  const { pool, cfg } = app();
  const [{ saved, error, params }, found, learnedAdj] = await Promise.all([flashOf(props), getMatchByRef(pool, session, ref), listAdjustments(pool, session)]);
  // A found job outside the matches (opened from "All" on a source, 2026-11-25) is scored on first open.
  const m = found ?? (await matchFoundJob(pool, session, ref) ? await getMatchByRef(pool, session, ref) : null);
  if (!m) notFound();
  const [docs, work, prefs, apps, ready, noAi, goals, perGoal] = await Promise.all([listDocuments(pool, session, m.public_ref), tailorWork(pool, session, m.public_ref), getPreferences(pool, session), listApplications(pool, session), tailorReadiness(pool, session), aiIsOff(),
    listGoals(pool, session), matchGoals(pool, session, m.id)]);
  // With more than one goal in use, the G-score is shown goal by goal, primary first (multi-goal brief §5.2).
  const manyGoals = goals.filter((g) => g.active).length > 1 && perGoal.length > 0;
  const labelOf = new Map(goals.map((g) => [g.id, goalLabel(g)]));
  // Opened from a goal's list: tracking or preparing it here stamps the application with that goal (§6).
  const ctxGoal = manyGoals && perGoal.some((x) => x.goal_id === params.goal) ? params.goal : undefined;
  const goalInput = ctxGoal ? <input type="hidden" name="goal" value={ctxGoal} /> : null;
  const lastResult = (work?.status === "done" ? work.result ?? {} : {}) as { empty?: boolean };
  const tracked = apps.find((a) => a.job_ref === m.public_ref);
  // A tracked job shows the application's own status card, stepper and "Your documents", worked out exactly as the
  // application page does, so the two pages always say the same thing in the same design (Yong, 2026-11-19).
  let journey = null;
  let packetLine: { state: string; drafted?: number } | null | undefined;
  let resumeState: string | null | undefined;
  let letterState: string | null | undefined;
  let stuck = false;
  if (tracked) {
    const [full, facts, applying, signals, sum] = await Promise.all([getApplication(pool, cfg, session, tracked.public_ref), journeyFacts(pool, session, tracked.public_ref),
      applyStatus(pool, session, tracked.public_ref), listEmailSignals(pool, session, tracked.public_ref), trackerSummary(pool, session)]);
    const f = facts[tracked.public_ref];
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: sum.timeZone }).format(new Date());
    const run = runLineOf(applying);
    journey = journeyFor(full ?? tracked, f, { today, timeZone: sum.timeZone },
      { run, signal: signals.length ? signals[signals.length - 1] : undefined, reached: full ? reachedOf(full.events) : undefined });
    stuck = isStuck(journey, tracked, run) && f?.packet?.failureReason !== "outcome_unknown";
    packetLine = f?.packet ? { state: f.packet.state, drafted: f.packet.draftsToCheck } : null;
    resumeState = f?.docs.resume;
    letterState = f?.docs.letter;
  }
  const preparing = !!work && (work.status === "queued" || work.status === "running");
  // What's being prepared: both documents, or only the one asked for ("Write a cover letter").
  const kinds = Array.isArray(work?.kinds) ? (work.kinds as string[]) : [];
  const writing = (k: string) => preparing && (!kinds.length || kinds.includes(k));
  const resume = docs.find((d) => d.type === "tailored_resume");
  const letter = docs.find((d) => d.type === "cover_letter");
  const minScore = prefs?.min_score_to_tailor ?? null;
  const back = `/jobs/${m.public_ref}`;
  const status = m.status === "saved" ? "saved" : m.status === "new" ? "new" : "passed";
  const comps = (m.components ?? []) as Array<{ key: string; label: string; weight: number; points: number; detail: string[] }>;
  const matched = (m.matched_skills ?? []) as Array<{ skill: string; skillId: string }>;
  const req = (m.requirements ?? {}) as { must_have?: string[]; nice_to_have?: string[]; years?: number | null; education?: string | null; authorisation?: string | null; confidence?: string };
  const adjustments = (m.adjustments ?? []) as Array<{ label: string; delta: number }>;
  const proof = (id: string) => (m.evidence as Array<{ skill_id: string; label: string }>).filter((e) => e.skill_id === id).map((e) => e.label);
  const thin = String(m.description_text ?? "").trim().length < 400;
  const employerPage = (m.sources as Array<{ url: string; active: boolean }>).find((s) => s.active)?.url ?? m.apply_url;

  return (
    <>
      <TopBar signedIn />
      <p><a href={ctxGoal ? `/jobs?goal=${ctxGoal}` : "/jobs"}>← All jobs</a></p>
      <Flash saved={saved} error={error} />
      <div className="job-head">
        <FitScores r={m} />
        <div>
          <h1>{m.title}</h1>
          <p className="job-meta">{m.employer_canonical} · {place(m)}{pay(m) ? ` · ${pay(m)}` : ""} · {posted(m.posted_at)}{tracked ? <> · <a href={`/applications/${tracked.public_ref}`}>See the application</a></> : null}</p>
        </div>
      </div>
      {m.posting_status !== "active" ? <p className="error" role="status">{t("jobs.closed")}</p> : null}
      {manyGoals ? (
        <>
          {m.c_summary ? <div className="fit-lines big"><div><strong>C</strong> {m.c_summary}</div></div> : null}
          {m.domain ? <p className="muted">Domain: {domainLabel(m.domain)}{m.domain_line ? <span className="small"> · {m.domain_line}</span> : null}</p> : null}
          {/* One block per goal: this is where a job is compared across goals. */}
          <section className="card goal-blocks" aria-label="Against each of your goals">
            {perGoal.map((x) => (
              <div key={x.goal_id} className="goal-block">
                <h3>{labelOf.get(x.goal_id) ?? "A goal"}{x.is_primary ? <span className="muted small"> · fits best</span> : null}</h3>
                <div className="fit-lines">
                  {x.tier && x.tier > 1 ? <div className={`tier-reason tier-${x.tier}`}>{tierReasonText(x.tier_reason, m.domain)}</div> : null}
                  <div><strong>G {x.g_score ?? "–"}</strong> {x.g_summary}</div>
                </div>
                {Array.isArray(x.tier_lines) && x.tier_lines.length ? <p className="muted small">{(x.tier_lines as string[]).join(" ")}</p> : null}
                {x.filtered ? <p className="error">Ruled out for this goal: {(x.filter_reasons as string[]).map((r) => r.replace(/\.$/, "")).join("; ")}.</p> : null}
                {(x.g_parts as FitPart[] | null)?.length ? (
                  <Details summary={`How we worked out the G-score for this goal (${x.g_score})`}>
                    <table className="breakdown"><tbody>
                      {(x.g_parts as FitPart[]).map((c) => <tr key={c.key}><th scope="row">{c.label}</th><td className="num">{c.weight ? `${c.points} of ${c.weight}` : "Not counted"}</td><td>{c.detail.join(" ")}</td></tr>)}
                    </tbody></table>
                  </Details>
                ) : null}
              </div>
            ))}
          </section>
        </>
      ) : (
        <>
          {m.g_summary || m.c_summary ? (
            <div className="fit-lines big">
              {m.g_summary ? <div><strong>G</strong> {m.g_summary}</div> : null}
              {m.c_summary ? <div><strong>C</strong> {m.c_summary}</div> : null}
            </div>
          ) : <p className="reason big">{m.reason_line}</p>}
          {/* Where it ranks, and why (2026-11-22): level, kind of role and domain against the goal. */}
          {m.tier && m.tier > 1 ? <p className={`tier-reason tier-${m.tier}`}>{tierReasonText(m.tier_reason, m.domain)}</p> : null}
          {m.domain ? <p className="muted">Domain: {domainLabel(m.domain)}{m.domain_line ? <span className="small"> · {m.domain_line}</span> : null}</p> : null}
          {Array.isArray(m.tier_lines) && m.tier_lines.length ? <p className="muted small">{(m.tier_lines as string[]).join(" ")}</p> : null}
          {m.filtered ? <p className="error">Your preferences rule this one out: {(m.filter_reasons as string[]).join("; ")}.</p> : null}
        </>
      )}
      {m.ladder_label ? <p><span className={`chip ladder-${m.ladder_tag}`}>{m.ladder_label}</span></p> : null}
      <FeedbackButtons matchId={m.id} status={status} back={back} justDone={params.done === m.id}
        why={PASS_REASONS.some(([k]) => k === params.why) ? params.why : undefined}
        learned={learnedAdj.filter((a) => (params.learned ?? "").split(",").includes(a.id)).map((a) => ({ id: a.id, label: a.label, active: a.active }))} />
      {preparing ? <meta httpEquiv="refresh" content="4" /> : null}
      {/* Problems first, in red. */}
      {ready.roles === 0 && !preparing ? (
        <p className="error" role="alert">{lastResult.empty ? "Nothing was prepared: " : "A resume can't be prepared yet: "}
          your profile has no work history. <a href="/profile/import">Add your resume</a> or <a href="/profile/experience">add a role</a>, then come back and prepare it.</p>
      ) : null}
      {work?.status === "failed" && !preparing ? <p className="error" role="alert">We couldn&apos;t prepare {Array.isArray(work.kinds) && work.kinds.length === 1 && work.kinds[0] === "letter" ? "your cover letter" : "your resume and cover letter"} this time. Try again below.</p> : null}
      {tracked && journey ? (
        <>
          <StatusBlock j={journey} appRef={tracked.public_ref} back={`/applications/${tracked.public_ref}`} card stuck={stuck} />
          <Stepper j={journey} base={`/applications/${tracked.public_ref}`} />
        </>
      ) : (
        <form action={trackAction} className="inline-actions">
          <input type="hidden" name="job" value={m.public_ref} /><input type="hidden" name="back" value={back} />{goalInput}
          <button className="secondary">Track this job</button>
          <span className="hint">Adds it to your applications so you can keep notes and follow-ups.</span>
        </form>
      )}

      {!journey || journey.index <= 3 ? (
        <DocChecklist resume={resume} letter={letter} resumeState={resumeState ?? (writing("resume") ? "writing" : resume?.status)}
          letterState={letterState ?? (writing("letter") ? "writing" : letter?.status)} jobRef={m.public_ref}
          back={`${back}#stage-getting_ready`} noAi={noAi} canWrite={!preparing && m.posting_status === "active"}
          packet={tracked ? packetLine ?? null : undefined} packetHref={tracked ? `/applications/${tracked.public_ref}#packet` : "#packet"} problem={journey?.tone === "problem"}>
          {!preparing && m.posting_status === "active" ? (
            <form action={tailorAction} id="prepare" className="doc-prepare">
              <input type="hidden" name="job" value={m.public_ref} /><input type="hidden" name="back" value={back} />{goalInput}
              {minScore !== null && m.score < minScore && !docs.length ? <p className="muted">This job scores below the {minScore} you set for preparing resumes.</p> : null}
              <button className={docs.length ? "secondary" : ""}>{docs.length ? "Prepare a fresh draft" : "Prepare a resume for this job"}</button>
              <p className="hint">Makes a resume and a cover letter from your profile as it is now, in its own words. Nothing is sent anywhere.</p>
            </form>
          ) : null}
        </DocChecklist>
      ) : null}

      {/* The whole job description, open by default (Yong, 2026-11-23): never folded away or cut short. */}
      <section className="card job-description" aria-label="Job description">
        <h2>Job description</h2>
        {thin ? <p className="muted small">This is all the text {m.ats_type === "linkedin_alert" ? "the job alert" : "the site we found it on"} gave. TC Hunter reads the full description from the employer&apos;s own posting when it can.</p> : null}
        <PostingText text={m.description_text} />
        {employerPage ? <p><a href={employerPage} rel="noopener noreferrer" target="_blank">See it on the employer&apos;s site</a></p> : null}
      </section>

      {(m.gap_skills as string[]).length ? (
        <section className="card">
          <h2>{t("jobs.gaps.title")}</h2>
          <p className="muted">{t("jobs.gaps.hint")}</p>
          <ul>{(m.gap_skills as string[]).map((g) => <li key={g}>{g}</li>)}</ul>
          <p><a href="/profile#skills">Add a skill you have, with proof</a></p>
        </section>
      ) : null}

      {([["G-score: against your goals", manyGoals ? [] : m.g_parts, m.g_score], ["C-score: against your experience and skills", m.c_parts, m.c_score]] as const).map(([title, parts, n]) =>
        (parts as FitPart[] | null)?.length ? (
          <Details key={title} summary={`How we worked out the ${title.split(":")[0]} (${n})`}>
            <p className="muted">{title}. Only what applies counts: a part the {title.startsWith("G") ? "goal leaves blank" : "posting doesn't ask for"} is left out, not marked down.</p>
            <table className="breakdown">
              <tbody>
                {(parts as FitPart[]).map((c) => (
                  <tr key={c.key}><th scope="row">{c.label}</th><td className="num">{c.weight ? `${c.points} of ${c.weight}` : "Not counted"}</td><td>{c.detail.join(" ")}</td></tr>
                ))}
              </tbody>
            </table>
          </Details>
        ) : null)}

      <Details summary={`How we worked out Best match (${m.score})`}>
        <table className="breakdown">
          <tbody>
            {comps.map((c) => (
              <tr key={c.key}>
                <th scope="row">{c.label}</th>
                <td className="num">{c.weight ? `${c.points} of ${c.weight}` : "Not counted"}</td>
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

      <Details summary={readWithoutAi(m.posting_parser) ? "What the job asks for (read without AI)" : "What the job asks for"}>
        {readWithoutAi(m.posting_parser) ? <p className="muted small">{READ_WITHOUT_AI}</p> : null}
        {req.must_have?.length ? <><h3>Required</h3><ul>{req.must_have.map((x) => <li key={x}>{x}</li>)}</ul></> : null}
        {req.nice_to_have?.length ? <><h3>Nice to have</h3><ul>{req.nice_to_have.map((x) => <li key={x}>{x}</li>)}</ul></> : null}
        {req.years ? <p>Experience asked for: {req.years}+ years</p> : null}
        {req.education ? <p>Education: {req.education}</p> : null}
        {req.authorisation ? <p>Work permission: {req.authorisation}</p> : null}
        {!req.must_have?.length && !req.nice_to_have?.length ? <p className="muted">We couldn't find a clear list of requirements. Read the full description above.</p> : null}
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
