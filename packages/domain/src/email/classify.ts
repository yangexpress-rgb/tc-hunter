import type { ApplicationStage } from "../applicationStages";
import { confirmationIn } from "../packet/map";

/**
 * Connected email (decision 13.3). Rules only: mail is never sent to an AI service.
 * A message is read in memory, matched to one tracked application, and turned into
 * at most one suggestion. Its subject and text are dropped straight after.
 */
export type EmailKind = "acknowledgement" | "interview" | "rejection" | "offer";

export interface MailMessage {
  id: string;
  from: string;      // the From header, e.g. "Contoso Talent <jobs@contoso.com>"
  subject: string;
  snippet: string;
  receivedAt: Date;
}

export interface TrackedForEmail {
  id: string;
  employer: string;
  title: string;
  stage: ApplicationStage;
  createdAt: Date;
  /** Hosts from the employer's own job pages (never job-board hosts). */
  domains: string[];
}

export interface EmailSuggestion {
  messageId: string; applicationId: string; kind: EmailKind; stage: ApplicationStage; senderDomain: string; receivedAt: Date;
  /** From an acknowledgement only: the confirmation number exactly as the email showed it, or null. */
  confirmationRef: string | null;
}

const RULES: Array<[EmailKind, RegExp]> = [
  // Order matters: a rejection often thanks you for applying, an offer often mentions the interview.
  ["rejection", /\b(unfortunately|regret to inform|not (be )?moving forward|decided (not )?to (move|proceed|pursue) (forward )?with other|other candidates|not been selected|position has been filled|will not be progressing|not to progress)\b/i],
  ["offer", /\b(pleased to (offer|extend)|offer letter|extend (you )?an offer|job offer|formal offer)\b/i],
  ["interview", /\b(interview|phone screen|schedule (a|an|some) (call|chat|time|conversation)|your availability|book a time|meet the team)\b/i],
  ["acknowledgement", /\b(received your application|thank(s| you) for (applying|your application|your interest)|application (has been )?(received|submitted)|we('ve| have) received)\b/i],
];

export function classifyEmail(m: Pick<MailMessage, "subject" | "snippet">): EmailKind | null {
  const text = `${m.subject}\n${m.snippet}`;
  for (const [kind, re] of RULES) if (re.test(text)) return kind;
  return null;
}

/** The domain an address is at, lower-case. "Contoso <jobs@mail.contoso.com>" gives "mail.contoso.com". */
export function senderDomain(from: string): string | null {
  const m = /@([A-Za-z0-9.-]+\.[A-Za-z]{2,})>?\s*$/.exec(from.trim());
  return m ? m[1]!.toLowerCase() : null;
}

/** Job boards and applicant-tracking systems: mail from them can be about any employer. */
const SHARED_HOSTS = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|workday\.com|myworkdayjobs\.com|smartrecruiters\.com|icims\.com|jobvite\.com|taleo\.net|successfactors\.com|linkedin\.com|indeed\.com|gmail\.com|outlook\.com|hotmail\.com|yahoo\.com)$/;

export function employerDomains(urls: string[]): string[] {
  const out = new Set<string>();
  for (const u of urls) {
    try {
      const h = new URL(u).hostname.toLowerCase();
      if (SHARED_HOSTS.test(h)) continue;
      const parts = h.split(".");
      out.add(parts.slice(-2).join(".")); // careers.contoso.com → contoso.com
    } catch { /* not an address */ }
  }
  return [...out];
}

const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const mentions = (hay: string, needle: string) => { const n = norm(needle); return n.length >= 3 && ` ${norm(hay)} `.includes(` ${n} `); };

/** What a kind of message would move an application to, from where it is now. Null when it wouldn't move it forward. */
export function stageFor(kind: EmailKind, now: ApplicationStage): ApplicationStage | null {
  const before: Record<EmailKind, ApplicationStage[]> = {
    acknowledgement: ["interested", "tailoring", "ready_to_apply"],
    interview: ["applied", "screening"],
    offer: ["applied", "screening", "interview"],
    rejection: ["applied", "screening", "interview", "offer"],
  };
  const to: Record<EmailKind, ApplicationStage> = { acknowledgement: "applied", interview: "interview", offer: "offer", rejection: "closed_lost" };
  return before[kind].includes(now) ? to[kind] : null;
}

/** One message → at most one suggestion for one application. Unclear matches are skipped, never guessed. */
export function suggestFromEmail(m: MailMessage, apps: TrackedForEmail[]): EmailSuggestion | null {
  const kind = classifyEmail(m);
  const domain = senderDomain(m.from);
  if (!kind || !domain) return null;
  const display = m.from.replace(/<[^>]*>/, "");
  // Mail from a week before tracking still counts (people often track a job after applying); older mail may be about an earlier application.
  let candidates = apps.filter((a) => m.receivedAt.getTime() >= a.createdAt.getTime() - 7 * 86_400_000 && (
    a.domains.some((d) => domain === d || domain.endsWith(`.${d}`)) || mentions(display, a.employer) || mentions(m.subject, a.employer)));
  if (candidates.length > 1) candidates = candidates.filter((a) => mentions(m.subject, a.title) || mentions(m.snippet, a.title));
  if (candidates.length !== 1) return null;
  const a = candidates[0]!;
  const stage = stageFor(kind, a.stage);
  if (!stage) return null;
  const conf = kind === "acknowledgement" ? confirmationIn(`${m.subject}\n${m.snippet}`) : null;
  return { messageId: m.id, applicationId: a.id, kind, stage, senderDomain: domain, receivedAt: m.receivedAt, confirmationRef: conf && /^[A-Za-z0-9-]{4,41}$/.test(conf) ? conf : null };
}

/** The Gmail search for mail from the employers being tracked, recent only. */
export function gmailQuery(apps: TrackedForEmail[], days = 14): string | null {
  const names = [...new Set(apps.map((a) => a.employer.replace(/["{}()]/g, "").trim()).filter((n) => n.length >= 3))].slice(0, 30);
  const domains = [...new Set(apps.flatMap((a) => a.domains))].slice(0, 30);
  const terms = [...names.map((n) => `"${n}"`), ...domains.map((d) => `from:${d}`)];
  return terms.length ? `newer_than:${days}d -in:sent -in:drafts -in:chats {${terms.join(" ")}}` : null;
}
