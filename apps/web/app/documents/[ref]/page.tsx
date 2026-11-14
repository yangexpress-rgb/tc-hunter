import { notFound } from "next/navigation";
import { getDocument, markDiffViewed, type DocumentView } from "@tc-hunter/db";
import { formatMetric, monthYear, type LetterSource, type ResumeSource } from "@tc-hunter/domain";
import { Details } from "@/components/Layers";
import { Advanced, AdvancedRow } from "@/components/advanced/Advanced";
import { Flash } from "@/components/profile/Fact";
import { TopBar } from "@/components/TopBar";
import { flashOf } from "@/lib/profile";
import { app, requireSession } from "@/lib/server";
import { approveAction, confirmAliasAction, editAction, newVersionAction } from "../actions";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ ref: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

const BLOCK_REASON: Record<string, string> = {
  no_source_fact: "Not backed by anything in your profile",
  gap_skill: "Claims a skill your profile doesn't show",
  number_mismatch: "Uses a number that isn't in your profile",
  date_mismatch: "Uses a date that isn't in your profile",
  new_name: "Names something your profile doesn't mention",
  proficiency_raise: "Makes your level sound higher than you said",
  unverified_fact: "Rests on a row you haven't checked yet",
  unconfirmed_alias: "A new name for one of your skills",
};
const KIND_LABEL = { resume: "Resume", letter: "Cover letter" } as const;
const STATUS_LABEL = { draft: "Draft", approved: "Approved", superseded: "Replaced by a newer version" } as const;

/**
 * Tailoring Studio (design 5.4): three panes. "This version" is where you edit;
 * "What changed" (diff, gaps and what wasn't added) must be opened before Approve
 * works; "Your profile" is the master it all comes from.
 */
export default async function DocumentPage(props: Props) {
  const session = await requireSession();
  const { ref } = await props.params;
  if (!/^D-\d+$/.test(ref)) notFound();
  const { pool, cfg } = app();
  const { saved, error, params } = await flashOf(props);
  const pane = ["changes", "profile"].includes(params.pane ?? "") ? params.pane! : "doc";
  let d = await getDocument(pool, cfg, session, ref);
  if (!d) notFound();
  if (pane === "changes" && d.status === "draft" && !d.diffViewedAt) {
    await markDiffViewed(pool, session, d.id);
    d = (await getDocument(pool, cfg, session, ref))!;
  }
  const here = `/documents/${d.ref}${pane === "doc" ? "" : `?pane=${pane}`}`;
  const draft = d.status === "draft";
  const latest = d.versions[0];

  return (
    <>
      <TopBar signedIn />
      <p><a href={`/jobs/${d.job.ref}`}>← {d.job.title}</a></p>
      <h1>{KIND_LABEL[d.kind]} for {d.job.title}</h1>
      <p className="job-meta">{d.job.employer} · Version {d.version} · {STATUS_LABEL[d.status]}</p>
      <Flash saved={saved || params.approved === "1"} error={error} />
      {params.approved === "1" ? <p className="status" role="status">Approved. You can download it below.</p> : null}

      <nav className="tabs" aria-label="Views">
        <a href={`/documents/${d.ref}`} aria-current={pane === "doc" ? "page" : undefined}>This version</a>
        <a href={`/documents/${d.ref}?pane=changes`} aria-current={pane === "changes" ? "page" : undefined}>
          What changed{d.blocked.filter((b) => !b.resolvedAt).length + d.gaps.length ? <span className="count">{d.blocked.filter((b) => !b.resolvedAt).length + d.gaps.length}</span> : null}
        </a>
        <a href={`/documents/${d.ref}?pane=profile`} aria-current={pane === "profile" ? "page" : undefined}>Your profile</a>
      </nav>

      <ApproveBar d={d} here={here} />
      {d.status === "superseded" && latest ? <p className="muted">A newer version exists: <a href={`/documents/${latest.ref}`}>version {latest.version}</a>.</p> : null}

      {pane === "doc" ? (d.source.kind === "resume" ? <ResumePane d={d} s={d.source} here={here} editable={draft} /> : <LetterPane d={d} s={d.source} here={here} editable={draft} name={session.preferredName} />) : null}
      {pane === "changes" ? <ChangesPane d={d} here={here} /> : null}
      {pane === "profile" ? <ProfilePane d={d} /> : null}

      {d.versions.length > 1 ? (
        <Details summary="Earlier versions">
          <ul>{d.versions.map((v) => <li key={v.ref}><a href={`/documents/${v.ref}`}>Version {v.version}</a> <span className="muted">{STATUS_LABEL[v.status as keyof typeof STATUS_LABEL]}</span></li>)}</ul>
        </Details>
      ) : null}

      <Advanced>
        <AdvancedRow label="Document ref" value={`${d.ref} (${d.type})`} />
        <AdvancedRow label="Written by" value={`${d.meta.proposer ?? "?"}${d.meta.model ? ` · ${d.meta.model}` : ""}${d.meta.prompt_version ? ` · prompt ${d.meta.prompt_version}` : ""}`} />
        <AdvancedRow label="Content hash" value={d.contentHash} />
        <AdvancedRow label="Diff viewed" value={d.diffViewedAt ? new Date(d.diffViewedAt).toISOString() : "not yet"} />
        {d.approvedAt ? <AdvancedRow label="Approved" value={new Date(d.approvedAt).toISOString()} /> : null}
        {d.usedIn.length ? <AdvancedRow label="Used in" value={d.usedIn.join(", ")} /> : null}
        <AdvancedRow label="Blocked by rule" value={d.blocked.map((b) => `${b.reason}[${b.terms.join("|")}]`).join(", ") || "none"} />
      </Advanced>
    </>
  );
}

function ApproveBar({ d, here }: { d: DocumentView; here: string }) {
  if (d.status === "draft") {
    return (
      <section className="card approve-bar">
        {d.diffViewedAt ? (
          <form action={approveAction}>
            <input type="hidden" name="doc" value={d.id} /><input type="hidden" name="back" value={`/documents/${d.ref}`} />
            <button>Approve this version</button>
            <span className="muted"> Approved versions are locked. You can still make a new one later.</span>
          </form>
        ) : (
          <p><span className="button disabled" aria-disabled="true">Approve this version</span>{" "}
            <span className="muted">First, look at <a href={`/documents/${d.ref}?pane=changes`}>what changed</a> from your profile.</span></p>
        )}
      </section>
    );
  }
  return (
    <section className="card approve-bar inline-actions">
      {d.status === "approved" ? (<>
        <a className="button" href={`/documents/${d.ref}/pdf`}>Download PDF</a>
        <a className="button secondary" href={`/documents/${d.ref}/docx`}>Download Word</a>
      </>) : null}
      <form action={newVersionAction}><input type="hidden" name="doc" value={d.id} /><input type="hidden" name="back" value={here} />
        <button className="secondary">Make changes</button></form>
    </section>
  );
}

const hidden = (d: DocumentView, here: string, fields: Record<string, string | number>) => (
  <>
    <input type="hidden" name="doc" value={d.id} /><input type="hidden" name="back" value={here} />
    {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={String(v)} />)}
  </>
);

function ResumePane({ d, s, here, editable }: { d: DocumentView; s: ResumeSource; here: string; editable: boolean }) {
  const total = s.experience.reduce((n, i) => n + i.lines.length, 0);
  const shown = s.experience.reduce((n, i) => n + i.lines.filter((l) => l.included).length, 0);
  return (
    <section className="doc-preview" aria-label="This version">
      <p className="muted">Showing {shown} of your {total} lines, to fit about {s.targetPages} {s.targetPages === 1 ? "page" : "pages"}. Names, dates and numbers come straight from your profile.</p>
      <h2>Experience</h2>
      {s.experience.map((it, ii) => (
        <article key={it.itemId} className={`doc-item${it.included ? "" : " is-off"}`}>
          <div className="doc-role"><strong>{it.title}</strong><span className="muted">{monthYear(it.start)} – {monthYear(it.end)}</span></div>
          {it.employer || it.location ? <div className="muted">{[it.employer, it.location].filter(Boolean).join(", ")}</div> : null}
          <ul className="doc-lines">
            {it.lines.map((l, li) => (
              <li key={li} className={l.included ? "" : "is-off"}>
                <span>{l.text}</span>
                {l.transform === "rephrased" ? <span className="chip">Reworded</span> : null}
                {editable ? (
                  <span className="line-tools">
                    <form action={editAction}>{hidden(d, here, { op: "toggle_line", item: ii, line: li })}<button className="small secondary">{l.included ? "Leave out" : "Put back"}</button></form>
                    <form action={editAction}>{hidden(d, here, { op: "move_line", item: ii, line: li, dir: -1 })}<button className="small secondary" aria-label="Move up" disabled={li === 0}>↑</button></form>
                    <form action={editAction}>{hidden(d, here, { op: "move_line", item: ii, line: li, dir: 1 })}<button className="small secondary" aria-label="Move down" disabled={li === it.lines.length - 1}>↓</button></form>
                    {l.transform === "rephrased" ? <form action={editAction}>{hidden(d, here, { op: "use_original", item: ii, line: li })}<button className="small secondary">Use my words</button></form> : null}
                    <details className="mini"><summary>Edit</summary>
                      <form action={editAction} className="inline-form">{hidden(d, here, { op: "edit_line", item: ii, line: li })}
                        <label>Wording<textarea name="text" rows={2} defaultValue={l.text} maxLength={1000} /></label>
                        <button className="small">Save</button>
                      </form>
                      <p className="hint">Names, numbers, dates and levels must match your profile row. To change a fact, change it in your profile.</p>
                    </details>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {editable ? (
            <form action={editAction}>{hidden(d, here, { op: "toggle_item", item: ii })}<button className="small secondary">{it.included ? "Leave out this role" : "Put this role back"}</button></form>
          ) : null}
        </article>
      ))}
      <h2>Skills</h2>
      <ul className="chips plain">
        {s.skills.map((k) => (
          <li key={k.skillId} className={k.included ? "" : "is-off"}>
            {editable ? (
              <form action={editAction}>{hidden(d, here, { op: "toggle_skill", skill: k.skillId })}
                <button className={`chip-button${k.included ? " on" : ""}`} aria-pressed={k.included}>{k.name}</button></form>
            ) : <span className="chip">{k.name}</span>}
          </li>
        ))}
      </ul>
      {editable ? <p className="hint">Tap a skill to show or hide it. Only skills from your profile can be listed.</p> : null}
      {s.education.length ? (<><h2>Education</h2><ul>{s.education.map((e) => <li key={e.id}>{[e.degree, e.field].filter(Boolean).join(", ")}{e.degree || e.field ? ", " : ""}{e.institution}{e.end ? ` (${monthYear(e.end)})` : ""}</li>)}</ul></>) : null}
      {s.credentials.length ? (<><h2>Certifications</h2><ul>{s.credentials.map((c) => <li key={c.id}>{[c.name, c.issuer].filter(Boolean).join(", ")}</li>)}</ul></>) : null}
    </section>
  );
}

function LetterPane({ d, s, here, editable, name }: { d: DocumentView; s: LetterSource; here: string; editable: boolean; name: string }) {
  return (
    <section className="doc-preview" aria-label="This version">
      <p>Dear {s.target.employer} hiring team,</p>
      {s.paragraphs.map((p, i) => (
        <div key={i} className={`doc-para${p.included ? "" : " is-off"}`}>
          <p>{p.text}</p>
          {editable ? (
            <span className="line-tools">
              <form action={editAction}>{hidden(d, here, { op: "toggle_para", para: i })}<button className="small secondary">{p.included ? "Leave out" : "Put back"}</button></form>
              <form action={editAction}>{hidden(d, here, { op: "move_para", para: i, dir: -1 })}<button className="small secondary" aria-label="Move up" disabled={i === 0}>↑</button></form>
              <form action={editAction}>{hidden(d, here, { op: "move_para", para: i, dir: 1 })}<button className="small secondary" aria-label="Move down" disabled={i === s.paragraphs.length - 1}>↓</button></form>
              <details className="mini"><summary>Edit</summary>
                <form action={editAction} className="inline-form">{hidden(d, here, { op: "edit_para", para: i })}
                  <label>Wording<textarea name="text" rows={3} defaultValue={p.text} maxLength={1000} /></label>
                  <button className="small">Save</button>
                </form>
              </details>
            </span>
          ) : null}
        </div>
      ))}
      <p>Sincerely,<br />{name}</p>
      {(d.meta.notes as string[] | undefined)?.map((n) => <p key={n} className="muted">{n}</p>)}
    </section>
  );
}

function ChangesPane({ d, here }: { d: DocumentView; here: string }) {
  const open = d.blocked.filter((b) => !b.resolvedAt);
  const s = d.source;
  const skillName = (id: string | null) => d.profile.skills.find((k) => k.id === id)?.name ?? "this skill";
  return (
    <section aria-label="What changed">
      <p className="status" role="status">{d.status === "draft" ? "You've looked at the changes. You can approve this version now." : "What this version changed from your profile."}</p>

      <div className="card">
        <h2>Not added ({open.length})</h2>
        {open.length === 0 ? <p className="muted">Nothing was held back.</p> : (
          <>
            <p className="muted">These suggestions were stopped because your profile doesn't back them. They are not in your document.</p>
            <ul className="plain blocked-list">
              {open.map((b) => (
                <li key={b.id}>
                  <div className="strike">{b.text}</div>
                  <div className="muted">{BLOCK_REASON[b.reason] ?? "Not backed by your profile"}{b.terms.length && b.reason !== "unconfirmed_alias" ? `: ${b.terms.join(", ")}` : ""}</div>
                  {b.reason === "unconfirmed_alias" && b.skillId && d.status === "draft" ? (
                    <form action={confirmAliasAction}><input type="hidden" name="blocked" value={b.id} /><input type="hidden" name="back" value={here} />
                      <button className="small secondary">Yes, "{b.terms[0]}" is another name for my {skillName(b.skillId)}</button></form>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>

      {d.gaps.length ? (
        <div className="card">
          <h2>Skills this job asks for that your profile doesn't show ({d.gaps.length})</h2>
          <p className="muted">They are never added for you. If you have one, add it to your profile with proof, then prepare this resume again.</p>
          <ul>{d.gaps.map((g) => <li key={g.skill}><strong>{g.skill}</strong> <span className="muted">asked for as "{g.requirement}"</span></li>)}</ul>
          <p><a href="/profile/skills">Add a skill with proof</a></p>
        </div>
      ) : null}

      {s.kind === "resume" ? (
        <div className="card">
          <h2>Your lines in this version</h2>
          {s.experience.map((it) => (
            <div key={it.itemId} className="diff-item">
              <strong>{it.title}{it.employer ? `, ${it.employer}` : ""}</strong>{it.included ? null : <span className="chip">Left out</span>}
              <ul className="plain">
                {it.lines.map((l, i) => (
                  <li key={i} className="diff-line">
                    {!l.included ? <><span className="chip">Left out</span> <span className="muted">{l.text}</span></>
                      : l.transform === "rephrased" ? (<>
                        <span className="chip">Reworded</span>
                        <div className="diff-old">Your words: {l.original}</div>
                        <div className="diff-new">This version: {l.text}</div>
                      </>)
                      : l.transform === "reordered" ? <><span className="chip">Moved up</span> {l.text}</>
                      : <><span className="chip">Same</span> {l.text}</>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="muted">Skills listed: {s.skills.filter((k) => k.included).map((k) => k.name).join(", ") || "none"}.
            {s.skills.some((k) => !k.included) ? ` Left out: ${s.skills.filter((k) => !k.included).map((k) => k.name).join(", ")}.` : ""}</p>
        </div>
      ) : (
        <div className="card">
          <h2>Where each paragraph comes from</h2>
          <ul className="plain">{s.paragraphs.map((p, i) => <li key={i}><span className="chip">{{ opening: "Opening", evidence: "Your experience", motivation: "Your saved answer", closing: "Closing" }[p.role]}</span> {p.included ? p.text : <span className="muted">(left out) {p.text}</span>}</li>)}</ul>
        </div>
      )}
    </section>
  );
}

function ProfilePane({ d }: { d: DocumentView }) {
  const p = d.profile;
  return (
    <section aria-label="Your profile">
      <p className="muted">Everything this document can draw on: only rows you've checked are used. <a href="/profile">Change your profile</a></p>
      {p.experience.filter((e) => e.verified).map((e) => (
        <article key={e.id} className="doc-item">
          <div className="doc-role"><strong>{e.title}</strong><span className="muted">{monthYear(e.start)} – {monthYear(e.end)}</span></div>
          {e.employer ? <div className="muted">{e.employer}</div> : null}
          <ul>{e.bullets.filter((b) => b.verified).map((b) => <li key={b.id}>{b.text}{b.metricValue !== null && !b.text.includes(String(b.metricValue)) ? ` (${formatMetric(b.metricValue, b.metricUnit)})` : ""}</li>)}</ul>
        </article>
      ))}
      <h2>Skills</h2>
      <p>{p.skills.filter((s) => s.verified).map((s) => `${s.name}${s.evidenceIds.length ? "" : " (no proof yet)"}`).join(", ") || "None yet."}</p>
      {p.experience.some((e) => !e.verified) ? <p className="muted">Some rows aren't checked yet and aren't used. <a href="/profile/review">Check them</a></p> : null}
    </section>
  );
}
