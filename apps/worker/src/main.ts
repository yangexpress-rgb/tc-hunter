/**
 * The background worker (design 7): runs scans, reads pasted job links, drafts
 * tailored documents and looks at connected mailboxes, one at a time, politely. It has no internet route of its own: every request goes through the
 * egress gate, which only lets it reach public hosts on HTTPS.
 */
import { createPool, enqueueDueApplies, enqueueDueEmailChecks, enqueueDueScansAndPrune, loadConfig, recoverInterruptedWork, loadSecretStore, resumeReaderName, runNextWork, settingsEnv, type EmailDeps } from "@tc-hunter/db";
import {
  ClaudeCompanyProposer, ClaudeLetterProposer, searchSites, ClaudeRequirementsReader, NamedCompaniesOnly, ClaudeResumeProposer, createLogger, PoliteFetcher, RulesLetterProposer, RulesRequirementsReader,
  ClaudeResumeParser, GmailReader, googleClientFrom, RulesResumeParser, RulesResumeProposer, type RequirementsReader,
} from "@tc-hunter/domain";
import { ServerBrowser } from "./apply/browser";

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
// Connected Gmail (decision 13.3): only when a Google client is configured and the vault is mounted.
const google = googleClientFrom(process.env);
const email: EmailDeps | undefined = google && process.env.TC_VAULT_DIR
  ? { vault: loadSecretStore(), cfg, reader: (token) => new GmailReader(google, token), postings: reader } : undefined;
// Resume digest (decision 13.6): Claude with contact details and the applicant's names removed, or the built-in rules.
const digest = {
  cfg,
  reader: (names: string[], instructions?: string | null) =>
    (resumeReaderName() === "claude" ? new ClaudeResumeParser(undefined, names, instructions ?? null) : new RulesResumeParser()),
  onRead: (info: Record<string, unknown>) => log.info("resume.digest_read", info),
};
// Finding places to look (Yong, 2026-11-14): Claude suggests employers for each goal when set up;
// otherwise only the companies the person named are looked up. Every board is checked before it's followed.
const discover = { proposer: resumeReaderName() === "claude" && process.env.TC_COMPANY_FINDER !== "rules" ? new ClaudeCompanyProposer() : new NamedCompaniesOnly() };
// Job-search sites (Yong, 2026-11-14): searched first for every goal; each turns on when its free key is set,
// in Settings (read again every minute, so a new key works without a restart) or as a Railway variable.
let search = searchSites(process.env).sites;
let searchReadAt = 0;
async function currentSearch() {
  if (Date.now() - searchReadAt > 60_000) {
    try { search = searchSites(await settingsEnv(pool, cfg, process.env)).sites; searchReadAt = Date.now(); }
    catch (e) { log.warn("worker.settings_failed", { message: String((e as Error).message ?? e).slice(0, 200) }); }
  }
  return search;
}
// Hands-free applying (Yong, 2026-11-15): TC Hunter's own browser, through the same outbound gate.
// Employer-site passwords live in each applicant's vault; Gmail confirms new Workday accounts.
const apply = process.env.TC_APPLY_BROWSER === "off" ? undefined : {
  browser: new ServerBrowser({ proxy: process.env.HTTPS_PROXY || undefined, executablePath: process.env.TC_CHROMIUM_PATH || undefined }),
  cfg, vault: process.env.TC_VAULT_DIR ? loadSecretStore() : undefined, email,
};
const IDLE_MS = Number(process.env.TC_WORKER_IDLE_MS ?? 5000);
const SCHEDULE_MS = 15 * 60_000;

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { stopping = true; log.info("worker.stopping", {}); });

async function main() {
  log.info("worker.started", { reader: reader.version, writer: tailor.resume.version, email: email ? "gmail.readonly" : "off", apply: apply ? "browser" : "off", companies: discover.proposer.version, search: search.map((s) => s.id).join(",") || "none" });
  // One worker: anything still marked running was cut off by the last restart or update.
  try {
    const n = await recoverInterruptedWork(pool);
    if (n) log.info("worker.recovered", { items: n });
  } catch (e) { log.warn("worker.recover_failed", { message: String((e as Error).message ?? e).slice(0, 200) }); }
  let lastSchedule = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastSchedule > SCHEDULE_MS) {
        const queued = await enqueueDueScansAndPrune(pool);
        const mail = email ? await enqueueDueEmailChecks(pool) : 0;
        const applies = apply ? await enqueueDueApplies(pool) : 0;
        lastSchedule = Date.now();
        if (queued || mail || applies) log.info("worker.scheduled", { scans: queued, email_checks: mail, applies });
      }
      // A fresh fetcher per piece of work: robots rules are read again each time.
      const did = await runNextWork(pool, { fetcher: new PoliteFetcher(), reader, tailor, email, digest, discover, search: await currentSearch(), apply });
      if (!did) await new Promise((r) => setTimeout(r, IDLE_MS));
      // Counts and timings only, never names or content, so a stuck or failed search can be traced.
      else log[did.ok ? "info" : "warn"]("work.finished", { kind: did.kind, ok: did.ok, seconds: Math.round(did.ms / 1000), attempt: did.attempt, ...(did.result ?? {}), ...(did.error ? { error: did.error } : {}) });
    } catch (e) {
      log.warn("worker.error", { message: String((e as Error).message ?? e).slice(0, 200) });
      await new Promise((r) => setTimeout(r, IDLE_MS * 4));
    }
  }
  await pool.end();
}
void main();
