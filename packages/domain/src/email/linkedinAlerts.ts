import { htmlToText } from "../jobs/text";
import { detectWorkplace } from "../jobs/normalize";
import type { RawPosting } from "../jobs/types";

/**
 * LinkedIn job alerts (Yong, 2026-11-14). LinkedIn can't be searched by another app,
 * and the person's LinkedIn account is never used by TC Hunter. Instead the person
 * sets up LinkedIn job alerts for their goals; the alert emails arrive in the Gmail
 * they connected, and the jobs listed in them are read from there. Only the job's
 * title, company, place and link are kept: nothing else from the email.
 */

/** Gmail search for LinkedIn's job alert emails from the last two weeks. */
export const LINKEDIN_ALERT_QUERY = "from:(jobalerts-noreply@linkedin.com OR jobs-noreply@linkedin.com) newer_than:14d";

const VIEW = /https?:\/\/(?:[a-z]{2,3}\.)?(?:www\.)?linkedin\.com\/(?:comm\/)?jobs\/view\/(\d{6,})/i;
const NOISE = /^(view job|apply|easy apply|see all jobs|new|promoted|actively recruiting|be an early applicant|\d+ (?:applicants?|connections?|alumni|school alumni).*|.*\bago\b|you'?re receiving|unsubscribe|help|linkedin|-{3,}|={3,}|·)$/i;

export interface AlertJob { linkedinId: string; title: string; company: string; location: string | null }

/**
 * The jobs in one alert email. Each job is the few lines just before its
 * "View job" link: its title, then its company and place (on one line with
 * " · " between them, or on two lines).
 */
export function jobsFromLinkedInAlert(body: string, isHtml = false): AlertJob[] {
  const text = isHtml ? htmlToText(body.replace(/<a\b[^>]*href="([^"]+)"[^>]*>/gi, "$&\n$1\n")) : body;
  // In HTML mail, table cells put blank lines between a job's own lines, so blank lines are dropped there.
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim()).filter((l) => l || !isHtml);
  const out = new Map<string, AlertJob>();
  for (let i = 0; i < lines.length; i++) {
    const m = VIEW.exec(lines[i]!);
    if (!m) continue;
    const id = m[1]!;
    if (out.has(id)) continue;
    // Walk back over the job's own lines, skipping labels, and stop at the previous job.
    const block: string[] = [];
    for (let j = i - 1; j >= 0 && block.length < 3; j--) {
      const l = lines[j]!.replace(/^view job:?\s*/i, "");
      if (VIEW.test(lines[j]!)) break;
      if (!l || NOISE.test(l) || /^https?:\/\//.test(l)) { if (block.length && !l) break; continue; }
      block.unshift(l);
    }
    if (block.length < 2) continue;
    const [title, ...rest] = block;
    let company = rest[0]!;
    let location: string | null = rest[1] ?? null;
    if (company.includes(" · ")) [company, location] = [company.split(" · ")[0]!, company.split(" · ").slice(1).join(" · ")];
    if (!title || !company || title.length > 150 || company.length > 120) continue;
    out.set(id, { linkedinId: id, title, company, location: location || null });
  }
  return [...out.values()];
}

/** An alert job as a posting. Its page is on LinkedIn, which is never opened, so the text is what the alert says. */
export function postingFromAlertJob(j: AlertJob, receivedAt: Date): RawPosting {
  const url = `https://www.linkedin.com/jobs/view/${j.linkedinId}/`;
  return {
    externalId: `linkedin:${j.linkedinId}`, url, employer: j.company, title: j.title, locationRaw: j.location,
    workplaceType: detectWorkplace(`${j.title} ${j.location ?? ""}`),
    descriptionText: `${j.title} at ${j.company}${j.location ? `, ${j.location}` : ""}. From your LinkedIn job alert. Open the job on LinkedIn for the full description.`,
    salary: null, postedAt: receivedAt.toISOString(), applyUrl: url, atsType: "linkedin_alert",
  };
}
