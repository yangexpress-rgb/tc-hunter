/**
 * The background worker (design 7): runs scans, reads pasted job links, drafts
 * tailored documents and looks at connected mailboxes, one at a time, politely. It has no internet route of its own: every request goes through the
 * egress gate, which only lets it reach public hosts on HTTPS.
 */
import { aiProviderSource, aiUsageSink, createPool, queueLostHandovers, tickHeld, enqueueDueApplies, enqueueDueEmailChecks, enqueueDueScansAndPrune, loadConfig, recoverInterruptedWork, loadSecretStore, resumeReaderName, runNextWork, settingsEnv, smartAnswersStatus, type EmailDeps } from "@tc-hunter/db";
import {
  ClaudeAnswerInferrer, ClaudeEssayDrafter, ClaudeCompanyProposer, ClaudeCareersLookup, ClaudeLetterProposer, ClaudeProofreader, searchSites, ClaudeRequirementsReader, NamedCompaniesOnly, ClaudeResumeProposer, createLogger, PoliteFetcher, RulesLetterProposer, RulesRequirementsReader,
  ClaudeResumeParser, mailReaderFor, googleClientFrom, RulesResumeParser, RulesResumeProposer, type GoogleClient, type RequirementsReader,
  HeldSessions, handoverHours, ClaudeRequirementsBatcher, setUsageSink, promptCacheOn, setAiProviderSource, setAiEventLog, currentAiProvider, aiModels,
} from "@tc-hunter/domain";
import { ServerBrowser } from "./apply/browser";
import { liveServer } from "./apply/live";
import { dumpPostings, evalProviders, runF9, runGenEval, runRequirementsEval } from "./evalF9";
import { runApplyEval } from "./evalApply";
import { stuckVerdict } from "./watchdog";

const log = createLogger();
const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);
// The AI cost meter (Yong, 2026-11-17): every Claude call's usage goes into ai_usage and the log.
setUsageSink(aiUsageSink(pool, log));
// Claude or OpenAI (Yong, 2026-11-18): every AI task follows Settings › AI provider. Each piece of work
// keeps the provider it started on; the OpenAI key comes from the vault.
setAiProviderSource(aiProviderSource(pool, process.env.TC_VAULT_DIR ? loadSecretStore() : undefined));
setAiEventLog((e, d) => log.warn(e, d));
const reader: RequirementsReader = resumeReaderName() === "claude" && process.env.TC_POSTING_READER !== "rules"
  ? new ClaudeRequirementsReader() : new RulesRequirementsReader();
// Scheduled searches read new postings in a batch at half price (Yong, 2026-11-17). On with TC_REQ_BATCH=on (until the before/after measurement is in).
const batch = reader instanceof ClaudeRequirementsReader && process.env.TC_REQ_BATCH === "on" ? new ClaudeRequirementsBatcher(reader) : undefined;
// Tailoring (design 5.4): Claude may reword, the rules decide what is true. TC_TAILOR_WRITER=rules keeps to the applicant's own words.
const claudeWrites = resumeReaderName() === "claude" && process.env.TC_TAILOR_WRITER !== "rules";
const tailor = {
  resume: claudeWrites ? new ClaudeResumeProposer() : new RulesResumeProposer(),
  letter: claudeWrites ? new ClaudeLetterProposer() : new RulesLetterProposer(),
  // The final review pass over each draft (Yong, 2026-11-18). TC_PROOFREAD=off skips it; the checker still blocks garbled text.
  proofread: claudeWrites && process.env.TC_PROOFREAD !== "off" ? new ClaudeProofreader() : undefined,
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
// "Your turn" (Yong, 2026-11-17): pages kept open at a step only the applicant may do, shown to them live
// through the web app (127.0.0.1 only, with a key made at every start). Without the key, no live view:
// such steps end with "Finish it yourself". Each open page costs memory, so at most 3 (2 per applicant).
const liveKey = process.env.TC_LIVE_KEY && process.env.TC_LIVE_KEY.length >= 32 ? process.env.TC_LIVE_KEY : null;
const held = liveKey && process.env.TC_APPLY_BROWSER !== "off" ? new HeldSessions(Number(process.env.TC_HANDOVER_MAX ?? 3) || 3, 2) : undefined;
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
  held,
  // A run whose browser closes because the worker is stopping (an app update) starts again by itself.
  stopping: () => stopping,
};
const smart = smartAnswersStatus();
const IDLE_MS = Number(process.env.TC_WORKER_IDLE_MS ?? 5000);
const SCHEDULE_MS = 15 * 60_000;

/** How long one piece of work may take before the worker counts it as stuck (minutes). */

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { stopping = true; log.info("worker.stopping", {}); });

async function main() {
  const provider = await currentAiProvider();
  log.info("worker.started", { ai_provider: provider, ai_models: JSON.stringify(aiModels()), reader: reader.version, writer: tailor.resume.version, email: email ? "gmail (app password or Google sign-in)" : "off", apply: apply ? "browser" : "off", answers: apply?.inferrer?.version ?? "off", answers_effort: apply?.inferrer ? smart.effort : undefined, essays: apply?.drafter?.version ?? "off", companies: discover.proposer.version, careers: discover.careers?.version ?? "off", req_batch: batch ? "on" : "off", prompt_cache: promptCacheOn() ? "on" : "off", search: search.map((s) => s.id).join(",") || "none" });
  if (!apply?.inferrer) log.warn("worker.smart_answers_off", { reason: smart.problem ?? "apply browser off" });
  // The F9 answer eval, once, when TC_EVAL_F9=1 is set on the server (it uses the server's own key).
  if (process.env.TC_EVAL_F9 === "1" && smart.on) {
    runF9(log).catch((e) => log.warn("eval.f9_failed", { message: String((e as Error)?.message ?? e).slice(0, 300) }));
  }
  // The requirements golden set, once, when TC_EVAL_REQ=1 is set (same key as the posting reader).
  if (process.env.TC_EVAL_REQ === "1" && smart.on) {
    runRequirementsEval(log).catch((e) => log.warn("eval.req_failed", { message: String((e as Error)?.message ?? e).slice(0, 300) }));
  }
  // The letter, About and essay golden sets, once, when TC_EVAL_GEN=1.
  if (process.env.TC_EVAL_GEN === "1" && smart.on) {
    runGenEval(log).catch((e) => log.warn("eval.gen_failed", { message: String((e as Error)?.message ?? e).slice(0, 300) }));
  }
  // One application end to end on a sandbox form, per provider (TC_EVAL_APPLY=1, providers from TC_EVAL_PROVIDERS).
  if (process.env.TC_EVAL_APPLY === "1" && smart.on) {
    (async () => { for (const p of evalProviders()) await runApplyEval(log, p, { executablePath: process.env.TC_CHROMIUM_PATH || undefined }); })()
      .catch((e) => log.warn("eval.apply_failed", { message: String((e as Error)?.message ?? e).slice(0, 300) }));
  }
  // Scanned job ads, word for word, for the golden sets (TC_EVAL_DUMP_POSTINGS=1).
  if (process.env.TC_EVAL_DUMP_POSTINGS === "1") {
    dumpPostings(pool, log).catch((e) => log.warn("eval.posting_dump_failed", { message: String((e as Error)?.message ?? e).slice(0, 300) }));
  }
  // One worker: anything still marked running was cut off by the last restart or update.
  try {
    const n = await recoverInterruptedWork(pool);
    if (n) log.info("worker.recovered", { items: n });
    // Pages that were waiting for an applicant are gone with the restart: each run ends it in plain words.
    const lost = await queueLostHandovers(pool);
    if (lost) log.info("worker.handovers_lost", { count: lost });
  } catch (e) { log.warn("worker.recover_failed", { message: String((e as Error).message ?? e).slice(0, 200) }); }
  if (held && liveKey) {
    const port = Number(process.env.TC_LIVE_PORT ?? 3130);
    liveServer(held, liveKey).listen(port, "127.0.0.1", () => log.info("worker.live_ready", { port, hours: handoverHours() }));
    // Expiry, the one reminder, and noticing the page moved past the step: every 5 seconds, alongside the work.
    let ticking = false;
    setInterval(() => {
      if (ticking || !held.all().length) return;
      ticking = true;
      tickHeld(pool, held).finally(() => { ticking = false; });
    }, 5000).unref();
  } else log.info("worker.live_off", { reason: process.env.TC_APPLY_BROWSER === "off" ? "apply browser off" : "TC_LIVE_KEY not set" });
  let lastSchedule = 0;
  // Watchdog: one piece of work that stops moving (a site or service that never answers) would hold up
  // everything after it. Stop the worker then; the app restarts and the work is queued again. A long
  // search that keeps moving is not stuck: its limit counts from its last step, up to a hard cap
  // (2026-11-18: a 47-source search was stopped at 45 minutes while still reading, three times over).
  let current: { kind: string; at: number; beat: number } | null = null;
  const onStart = (w: { kind: string; attempt: number }) => { current = { kind: w.kind, at: Date.now(), beat: Date.now() }; log.info("work.started", w); };
  const onProgress = () => { if (current) current.beat = Date.now(); };
  setInterval(() => {
    if (!current) return;
    const verdict = stuckVerdict(current, Date.now());
    if (verdict) {
      log.warn("work.stuck", { kind: current.kind, ...verdict });
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
      const did = await runNextWork(pool, { fetcher: new PoliteFetcher(), reader, tailor, email, digest, discover, search, apply, onStart, onProgress, batch });
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
