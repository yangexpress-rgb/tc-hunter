/**
 * The background worker (design 7): runs scans, reads pasted job links, drafts
 * tailored documents and looks at connected mailboxes, one at a time, politely. It has no internet route of its own: every request goes through the
 * egress gate, which only lets it reach public hosts on HTTPS.
 */
import { createPool, enqueueDueApplies, enqueueDueEmailChecks, enqueueDueScansAndPrune, loadConfig, recoverInterruptedWork, loadSecretStore, resumeReaderName, runNextWork, settingsEnv, smartAnswersStatus, type EmailDeps } from "@tc-hunter/db";
import {
  ClaudeAnswerInferrer, ClaudeEssayDrafter, ClaudeCompanyProposer, ClaudeCareersLookup, ClaudeLetterProposer, searchSites, ClaudeRequirementsReader, NamedCompaniesOnly, ClaudeResumeProposer, createLogger, PoliteFetcher, RulesLetterProposer, RulesRequirementsReader,
  ClaudeResumeParser, mailReaderFor, googleClientFrom, RulesResumeParser, RulesResumeProposer, type GoogleClient, type RequirementsReader,
} from "@tc-hunter/domain";
import { ServerBrowser } from "./apply/browser";
import { runF9 } from "./evalF9";

const log = createLogger();
const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);
const reader: RequirementsReader = resumeReaderName() === "claude" && process.env.TC_POSTING_READER !== "rules"
  ? new ClaudeRequirementsReader() : new RulesRequirementsReader();
// Tailoring (design 5.4): Claude may reword, the rules decide what is true. TC_TAILOR_WRITER=rules keeps to the applicant's own words.
const claudeWrites = resumeReaderName() === "claude" && process.env.TC_TAILOR_WRITER !== "rules";
const tailor = {
  resume: claudeWrites ? new ClaudeResumeProposer() : new RulesResumeProposer(),
  letter: claudeWrites ? new ClaudeLetterProposer() : new RulesLetterProposer(),
  cfg,
};
// Connected Gmail (decision 13.3): each applicant connects with an app password (Yong, 2026-11-15)
// or through a Google sign-in client when one is set up (Settings › Email or Railway, read again
// every minute below). Only needs the vault mounted.
let google: GoogleClient | null = googleClientFrom(process.env);
const email: EmailDeps | undefined = process.env.TC_VAULT_DIR
  ? { vault: loadSecretStore(), cfg, reader: (token) => mailReaderFor(token, google, { proxy: process.env.HTTPS_PROXY || undefined }), postings: reader } : undefined;
// Resume digest (decision 13.6): Claude with contact details and the applicant's names removed, or the built-in rules.
const digest = {
  cfg,
  reader: (names: string[], instructions?: string | null) =>
    (resumeReaderName() === "claude" ? new ClaudeResumeParser(undefined, names, instructions ?? null) : new RulesResumeParser()),
  onRead: (info: Record<string, unknown>) => log.info("resume.digest_read", info),
};
// Finding places to look (Yong, 2026-11-14): Claude suggests employers for each goal when set up;
// otherwise only the companies the person named are looked up. Every board is checked before it's followed.
const proposer = resumeReaderName() === "claude" && process.env.TC_COMPANY_FINDER !== "rules" ? new ClaudeCompanyProposer() : new NamedCompaniesOnly();
// Claude also says where an employer lists its jobs when its name leads nowhere, or its board lists none (Yong, 2026-11-17).
const discover = { proposer, careers: proposer instanceof ClaudeCompanyProposer ? new ClaudeCareersLookup() : undefined };
// Job-search sites (Yong, 2026-11-14): searched first for every goal; each turns on when its free key is set,
// in Settings (read again every minute, so a new key works without a restart) or as a Railway variable.
let search = searchSites(process.env).sites;
let searchReadAt = 0;
async function currentSearch() {
  if (Date.now() - searchReadAt > 60_000) {
    try {
      const env = await settingsEnv(pool, cfg, process.env);
      search = searchSites(env).sites;
      google = googleClientFrom(env);
      searchReadAt = Date.now();
    }
    catch (e) { log.warn("worker.settings_failed", { message: String((e as Error).message ?? e).slice(0, 200) }); }
  }
  return search;
}
// Hands-free applying (Yong, 2026-11-15): TC Hunter's own browser, through the same outbound gate.
// Employer-site passwords live in each applicant's vault; Gmail confirms new Workday accounts.
const apply = process.env.TC_APPLY_BROWSER === "off" ? undefined : {
  browser: new ServerBrowser({ proxy: process.env.HTTPS_PROXY || undefined, executablePath: process.env.TC_CHROMIUM_PATH || undefined }),
  cfg, vault: process.env.TC_VAULT_DIR ? loadSecretStore() : undefined, email,
  // Questions worked out from the applicant's full profile and checked against it (Yong, 2026-11-17); long written
  // answers drafted for the applicant to approve. TC_ANSWER_INFER=off stops both (Settings then says so, in red).
  inferrer: smartAnswersStatus().on ? new ClaudeAnswerInferrer() : undefined,
  drafter: smartAnswersStatus().on ? new ClaudeEssayDrafter() : undefined,
  // Jobs from LinkedIn or Indeed are applied for on the employer's own site (Yong, 2026-11-17); Claude says where to look when board names don't answer.
  careers: discover.careers,
};
const smart = smartAnswersStatus();
const IDLE_MS = Number(process.env.TC_WORKER_IDLE_MS ?? 5000);
const SCHEDULE_MS = 15 * 60_000;

/** How long one piece of work may take before the worker counts it as stuck (minutes). */
const STUCK_MINUTES: Record<string, number> = { scan: 45, apply: 30, tailor: 20, resume_digest: 20, email_check: 15 };

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { stopping = true; log.info("worker.stopping", {}); });

async function main() {
  log.info("worker.started", { reader: reader.version, writer: tailor.resume.version, email: email ? "gmail (app password or Google sign-in)" : "off", apply: apply ? "browser" : "off", answers: apply?.inferrer?.version ?? "off", answers_effort: apply?.inferrer ? smart.effort : undefined, essays: apply?.drafter?.version ?? "off", companies: discover.proposer.version, search: search.map((s) => s.id).join(",") || "none" });
  if (!apply?.inferrer) log.warn("worker.smart_answers_off", { reason: smart.problem ?? "apply browser off" });
  // The F9 answer eval, once, when TC_EVAL_F9=1 is set on the server (it uses the server's own key).
  if (process.env.TC_EVAL_F9 === "1" && smart.on) {
    runF9(log).catch((e) => log.warn("eval.f9_failed", { message: String((e as Error)?.message ?? e).slice(0, 300) }));
  }
  // One worker: anything still marked running was cut off by the last restart or update.
  try {
    const n = await recoverInterruptedWork(pool);
    if (n) log.info("worker.recovered", { items: n });
  } catch (e) { log.warn("worker.recover_failed", { message: String((e as Error).message ?? e).slice(0, 200) }); }
  let lastSchedule = 0;
  // Watchdog: one piece of work that runs far too long (a site or service that never answers) would
  // hold up everything after it. Stop the worker then; the app restarts and the work is queued again.
  let current: { kind: string; at: number } | null = null;
  const onStart = (w: { kind: string; attempt: number }) => { current = { kind: w.kind, at: Date.now() }; log.info("work.started", w); };
  setInterval(() => {
    if (!current) return;
    const mins = (Date.now() - current.at) / 60_000;
    if (mins > (STUCK_MINUTES[current.kind] ?? 20)) {
      log.warn("work.stuck", { kind: current.kind, minutes: Math.round(mins) });
      process.exit(1);
    }
  }, 60_000).unref();
  while (!stopping) {
    try {
      // Settings first: a Gmail sign-in or job-site key saved a minute ago is used from here on.
      const search = await currentSearch();
      if (Date.now() - lastSchedule > SCHEDULE_MS) {
        const queued = await enqueueDueScansAndPrune(pool);
        const mail = email ? await enqueueDueEmailChecks(pool) : 0;
        const applies = apply ? await enqueueDueApplies(pool) : 0;
        lastSchedule = Date.now();
        if (queued || mail || applies) log.info("worker.scheduled", { scans: queued, email_checks: mail, applies });
      }
      // A fresh fetcher per piece of work: robots rules are read again each time.
      const did = await runNextWork(pool, { fetcher: new PoliteFetcher(), reader, tailor, email, digest, discover, search, apply, onStart });
      current = null;
      if (!did) await new Promise((r) => setTimeout(r, IDLE_MS));
      // Counts and timings only, never names or content, so a stuck or failed search can be traced.
      else log[did.ok ? "info" : "warn"]("work.finished", { kind: did.kind, ok: did.ok, seconds: Math.round(did.ms / 1000), attempt: did.attempt, ...(did.result ?? {}), ...(did.error ? { error: did.error } : {}) });
    } catch (e) {
      current = null;
      log.warn("worker.error", { message: String((e as Error).message ?? e).slice(0, 200) });
      await new Promise((r) => setTimeout(r, IDLE_MS * 4));
    }
  }
  await pool.end();
}
void main();
