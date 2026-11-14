/**
 * The background worker (design 7): runs scans, reads pasted job links and drafts
 * tailored documents, one at a time, politely. It has no internet route of its own: every request goes through the
 * egress gate, which only lets it reach public hosts on HTTPS.
 */
import { createPool, enqueueDueScansAndPrune, loadConfig, resumeReaderName, runNextWork } from "@tc-hunter/db";
import {
  ClaudeLetterProposer, ClaudeRequirementsReader, ClaudeResumeProposer, createLogger, PoliteFetcher, RulesLetterProposer, RulesRequirementsReader,
  RulesResumeProposer, type RequirementsReader,
} from "@tc-hunter/domain";

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
const IDLE_MS = Number(process.env.TC_WORKER_IDLE_MS ?? 5000);
const SCHEDULE_MS = 15 * 60_000;

let stopping = false;
for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => { stopping = true; log.info("worker.stopping", {}); });

async function main() {
  log.info("worker.started", { reader: reader.version, writer: tailor.resume.version });
  let lastSchedule = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastSchedule > SCHEDULE_MS) {
        const queued = await enqueueDueScansAndPrune(pool);
        lastSchedule = Date.now();
        if (queued) log.info("worker.scheduled", { scans: queued });
      }
      // A fresh fetcher per piece of work: robots rules are read again each time.
      const did = await runNextWork(pool, { fetcher: new PoliteFetcher(), reader, tailor });
      if (!did) await new Promise((r) => setTimeout(r, IDLE_MS));
    } catch (e) {
      log.warn("worker.error", { message: String((e as Error).message ?? e).slice(0, 200) });
      await new Promise((r) => setTimeout(r, IDLE_MS * 4));
    }
  }
  await pool.end();
}
void main();
