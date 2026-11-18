import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ClaudeAnswerInferrer, scoreAnswers, setUsageSink, withAiProvider, withUsageScope, cacheHitRate, modelFor, ANSWER_MODEL,
  type AiProvider, type AiUsage, type EvalQuestion, type FillItem, type InferFacts, type UsageSink,
} from "@tc-hunter/domain";
import { ServerBrowser } from "./apply/browser";

type Log = { info: (e: string, d: Record<string, unknown>) => void; warn: (e: string, d: Record<string, unknown>) => void };

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** A Greenhouse-shaped sandbox application holding the F9 questions, served only on this machine. */
export function sandboxForm(questions: EvalQuestion[]): string {
  const field = (q: EvalQuestion) => {
    const id = q.key;
    if (q.type === "select") return `<div class="field"><label for="${id}">${esc(q.label)}</label><select id="${id}" name="${id}">${(q.options ?? []).map((o) => `<option${o === "Select One" ? ' value=""' : ""}>${esc(o)}</option>`).join("")}</select></div>`;
    if (q.type === "radio") return `<fieldset class="field"><legend>${esc(q.label)}</legend>${(q.options ?? []).map((o, i) => `<label><input type="radio" name="${id}" value="${esc(o)}" id="${id}_${i}"> ${esc(o)}</label>`).join("")}</fieldset>`;
    if (q.type === "checkbox") return `<div class="field"><input type="checkbox" id="${id}" name="${id}" value="Yes"><label for="${id}">${esc(q.label)}</label></div>`;
    return `<div class="field"><label for="${id}">${esc(q.label)}</label><input type="text" id="${id}" name="${id}"></div>`;
  };
  return `<!doctype html><html><head><title>Application</title></head><body><div id="application"><h1>Director of Operations</h1>
<form id="application_form" method="post" action="/submit">${questions.map(field).join("\n")}
<input type="submit" id="submit_app" value="Submit Application"></form></div></body></html>`;
}

/**
 * One application answered end to end on fixture data (Yong, 2026-11-18: proof before the provider
 * switch is used for real). TC Hunter's own browser opens a sandbox employer form (the F9 questions,
 * served on 127.0.0.1, nothing leaves the machine but the AI calls), reads it the way it reads a real
 * form, works out the answers from the F9 profile with the check (verify pass) on, fills them in,
 * presses Submit once and reads what the "employer" received. Scored against F9's expected answers.
 * Turned on by TC_EVAL_APPLY=1, on the provider(s) in TC_EVAL_PROVIDERS.
 */
export function runApplyEval(log: Log, provider: AiProvider, opts: { executablePath?: string } = {}) {
  return withAiProvider(provider, () => applyEvalOn(log, provider, opts));
}

async function applyEvalOn(log: Log, provider: AiProvider, opts: { executablePath?: string }) {
  const dir = join(process.cwd(), "fixtures", "f9");
  const { _about: _a, ...facts } = JSON.parse(await readFile(join(dir, "profile.json"), "utf8")) as InferFacts & { _about?: string };
  const questions = (JSON.parse(await readFile(join(dir, "questions.json"), "utf8")) as { questions: EvalQuestion[] }).questions;
  const received: Array<Record<string, string>> = [];
  const html = sandboxForm(questions);
  const server = createServer((req, res) => {
    if (req.method === "POST" && req.url?.startsWith("/submit")) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        received.push(Object.fromEntries(new URLSearchParams(body)));
        res.writeHead(200, { "content-type": "text/html" }).end("<h1>Thank you for applying!</h1><p>Your confirmation number: SANDBOX-1</p>");
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", () => ok()));
  const a = server.address();
  const url = `http://127.0.0.1:${typeof a === "object" && a ? a.port : 0}/jobs/1`;
  const run = `eval:apply:${provider}`;
  const usage: AiUsage[] = [];
  const prev = (globalThis as unknown as { __tcUsageSink?: UsageSink | null }).__tcUsageSink ?? null;
  setUsageSink((u) => { if (u.run === run) usage.push(u); return prev?.(u); });
  const started = Date.now();
  // No proxy: the sandbox is on this machine (the browser refuses local addresses when it has one).
  const page = await new ServerBrowser({ executablePath: opts.executablePath, timeoutMs: 20_000 }).open(url);
  try {
    const form = await page.openForm("greenhouse");
    const plainKey = (k: string) => k.replace(/^#/, "").replace(/^radio:/, "");
    const asked = form.fields.filter((f) => f.type !== "file").map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options }));
    const inferrer = new ClaudeAnswerInferrer();
    const out = await withUsageScope({ run, test: true }, () => inferrer.infer(asked, facts as InferFacts));
    const items: FillItem[] = out.answers.filter((x) => x.answer !== null).map((x) => ({ key: x.key, type: asked.find((q) => q.key === x.key)!.type as FillItem["type"], value: x.answer }));
    const filled = await page.fill(items);
    const pressed = await page.submit("#submit_app");
    await new Promise((ok) => setTimeout(ok, 1500));
    const got = received[0] ?? {};
    // What the employer actually received, per question, scored like F9.
    const sent = questions.flatMap((q) => (got[q.key] ? [{ key: q.key, answer: got[q.key]!, basis: "" }] : []));
    const score = scoreAnswers(questions, sent);
    log.info("eval.apply_score", {
      provider, by: inferrer.version, model: modelFor("judgment", ANSWER_MODEL), fields_read: form.fields.length, asked: asked.length,
      answered: out.answers.length, checked_out: (out.rejected ?? []).length, filled: filled.filter((f) => f.status === "filled").length,
      fill_problems: filled.filter((f) => f.status !== "filled").map((f) => `${f.key}: ${f.status}`).join(" | "),
      submitted: pressed, employer_received: received.length === 1, correct: score.correct, total: score.total, wrong: score.wrong, missed: score.missed, fabricated: score.fabricated,
      calls: usage.length, cost_usd: Number(usage.reduce((s, u) => s + u.costUsd, 0).toFixed(4)), cache_hit: Math.round(cacheHitRate(usage) * 1000) / 10,
      seconds: Math.round((Date.now() - started) / 1000), problems: out.problems.join(" | ").slice(0, 800),
    });
    for (const r of score.rows) {
      log.info("eval.apply_row", { provider, key: r.key, result: r.result, question: r.label.slice(0, 100), sent: got[r.key] ?? null, expect: r.expect.map((e) => e ?? "(left for you)").join(" / "),
        read_as: form.fields.find((f) => plainKey(f.key) === r.key)?.label.slice(0, 100) ?? "(not read)",
        rejected: out.rejected?.find((x) => plainKey(x.key) === r.key)?.why ?? null });
    }
  } finally {
    setUsageSink(prev);
    await page.close().catch(() => undefined);
    server.close();
  }
}
