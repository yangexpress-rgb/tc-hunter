import { listDocuments } from "@tc-hunter/db";
import { TopBar } from "@/components/TopBar";
import { app, requireSession } from "@/lib/server";

export const dynamic = "force-dynamic";

const LABEL: Record<string, string> = { tailored_resume: "Resume", cover_letter: "Cover letter" };
const STATUS: Record<string, string> = { draft: "Draft, waiting for you", approved: "Approved", superseded: "Replaced" };

/** Your documents: the latest version of each tailored resume and cover letter, by job. */
export default async function DocumentsPage() {
  const session = await requireSession();
  const rows = await listDocuments(app().pool, session);
  const jobs = new Map<string, { title: string; employer: string; ref: string; docs: Array<(typeof rows)[number]> }>();
  for (const r of rows) {
    const j = jobs.get(r.job_ref) ?? { title: r.title, employer: r.employer_canonical, ref: r.job_ref, docs: [] };
    j.docs.push(r);
    jobs.set(r.job_ref, j);
  }
  return (
    <>
      <TopBar signedIn />
      <h1>Documents</h1>
      {jobs.size === 0 ? (
        <p className="muted empty">No documents yet. Open a job you like and choose <strong>Prepare a resume for this job</strong>. <a href="/jobs">See jobs</a></p>
      ) : (
        <ul className="plain job-list">
          {[...jobs.values()].map((j) => (
            <li key={j.ref} className="card">
              <a className="job-title" href={`/jobs/${j.ref}`}>{j.title}</a>
              <div className="job-meta">{j.employer}</div>
              <ul className="plain">
                {j.docs.sort((a, b) => a.type.localeCompare(b.type)).reverse().map((d) => (
                  <li key={d.id}><a href={`/documents/${d.public_ref}`}>{LABEL[d.type] ?? "Document"}, version {d.version}</a>{" "}
                    <span className={d.status === "draft" ? "warn" : "muted"}>{STATUS[d.status]}</span></li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
