import type pg from "pg";
import {
  aboutFromResume, aboutIsInResume, contactBlockEnd, stripContactDetails, type AboutFinder, ANSWER_PRESETS, contactFromResume, normaliseAbout, decryptField, encryptField, extractText, open, parseLinkedInExport, profileFieldFor, questionCategory, EMPLOYER_CATEGORIES, namesEmployer, answerEmployerKey, normalQuestion,
  type ProfileField, type ResumeFileKind,
} from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import type { Session } from "./auth";
import type { AppConfig } from "./config";
import { withApplicant } from "./context";
import { DomainError } from "./packets";
import { asApplicant, dataKeyFor } from "./profile";

/**
 * Fewer questions while applying (Yong, 2026-11-15): "pull the information from the initial
 * resume as much as possible, such as email, name, phone", and "once user provided [an
 * answer] in the hands-free application, the app should save to my profile accordingly, so
 * next time similar application wouldn't need to ask again".
 *
 * Contact details are read from the stored original resume on this server (plain rules,
 * never an AI service: §13.6 keeps contact details away from it) and only fill gaps; what
 * the applicant typed in their profile always wins.
 */

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Fills empty profile details (name, email, phone, city, LinkedIn, GitHub, website, About) from the
 * newest uploaded resume. Returns what it filled. The About is the resume's own summary, word for
 * word (Yong, 2026-11-17); once the applicant has an About it is never replaced from a file.
 */
export async function fillProfileFromResume(c: pg.PoolClient, cfg: AppConfig, applicantId: string): Promise<string[]> {
  const a = (await c.query("SELECT legal_name_enc, preferred_name, email_enc, phone_enc, city, region, links, about_enc FROM applicant WHERE id = $1", [applicantId])).rows[0];
  if (!a) return [];
  const links = (a.links ?? {}) as Record<string, string>;
  const has = (re: RegExp) => Object.entries(links).some(([k, v]) => re.test(k) || re.test(String(v)));
  const want = {
    name: !a.legal_name_enc, email: !a.email_enc, phone: !a.phone_enc, city: !a.city,
    linkedin: !has(/linkedin/i), github: !has(/github/i), website: !has(/^(website|portfolio|site|web)$/i), about: !a.about_enc,
  };
  if (!Object.values(want).some(Boolean)) return [];
  const files = (await c.query(
    "SELECT kind, file_kind, content_enc FROM resume_file ORDER BY (kind = 'resume') DESC, created_at DESC LIMIT 3")).rows;
  if (!files.length) return [];
  const dk = await dataKeyFor(c, cfg, applicantId);
  const found: ReturnType<typeof contactFromResume> = { links: {} };
  let about: { text: string; source: "resume" | "linkedin" } | null = null;
  for (const f of files) {
    let text = "";
    try {
      const bytes = open(dk, f.content_enc, "file:resume_file.content");
      if (f.file_kind === "zip") {
        const li = parseLinkedInExport(bytes);
        text = li.sourceText;
        if (!about && li.about) about = { text: li.about, source: "linkedin" };
      } else text = await extractText(f.file_kind as ResumeFileKind, bytes);
    } catch { continue; }
    if (!about && f.file_kind !== "zip") {
      const t = aboutFromResume(text);
      if (t) about = { text: t, source: f.kind === "linkedin" ? "linkedin" : "resume" };
    }
    const k = contactFromResume(text);
    found.name ??= k.name; found.email ??= k.email; found.phone ??= k.phone;
    if (!found.city && k.city) { found.city = k.city; found.region = k.region; }
    found.links.linkedin ??= k.links.linkedin; found.links.github ??= k.links.github; found.links.website ??= k.links.website;
  }
  const filled: string[] = [];
  const enc = (col: string, v: string) => encryptField(dk, `applicant.${col}`, v);
  if (want.name && found.name) {
    await c.query("UPDATE applicant SET legal_name_enc = $2, preferred_name = CASE WHEN preferred_name IN ('', 'You') THEN $3 ELSE preferred_name END, updated_at = now() WHERE id = $1",
      [applicantId, enc("legal_name", found.name), found.name.split(" ")[0]]);
    filled.push("name");
  }
  if (want.email && found.email) { await c.query("UPDATE applicant SET email_enc = $2, updated_at = now() WHERE id = $1", [applicantId, enc("email", found.email)]); filled.push("email"); }
  if (want.phone && found.phone) { await c.query("UPDATE applicant SET phone_enc = $2, updated_at = now() WHERE id = $1", [applicantId, enc("phone", found.phone)]); filled.push("phone"); }
  if (want.city && found.city) {
    await c.query("UPDATE applicant SET city = $2, region = coalesce(region, $3), updated_at = now() WHERE id = $1", [applicantId, found.city.slice(0, 100), found.region?.slice(0, 100) ?? null]);
    filled.push("city");
  }
  const add: Record<string, string> = {};
  for (const k of ["linkedin", "github", "website"] as const) if (want[k] && found.links[k]) { add[k] = found.links[k]!.slice(0, 300); filled.push(k); }
  if (Object.keys(add).length) await c.query("UPDATE applicant SET links = links || $2::jsonb, updated_at = now() WHERE id = $1", [applicantId, JSON.stringify(add)]);
  if (want.about && about) {
    await c.query("UPDATE applicant SET about_enc = $2, about_source = $3, about_updated_at = now(), updated_at = now() WHERE id = $1 AND about_enc IS NULL",
      [applicantId, enc("about", normaliseAbout(about.text)), about.source]);
    filled.push("about");
  }
  if (filled.length) await recordAudit(c, "profile.filled_from_resume", { objectType: "applicant", objectId: applicantId, payload: { fields: filled.join(",") } });
  return filled;
}

/**
 * Keeps an answer the applicant typed on an application, so the next form with the same
 * question doesn't ask again: a profile detail (name, email, phone, links, city, country)
 * goes into the profile; anything else becomes an approved saved answer for that question.
 */
export async function keepAnswer(c: pg.PoolClient, dk: Buffer, applicantId: string, label: string, type: string, answer: string, opts: { employer?: string | null } = {}): Promise<string | null> {
  const text = answer.trim();
  const question = label.replace(/\s+/g, " ").replace(/[\s*:?]+$/, "").trim().slice(0, 200);
  if (!text || type === "file" || question.length < 2) return null;
  const field = profileFieldFor(label);
  if (field) { await keepProfileDetail(c, dk, applicantId, field, text.slice(0, 300)); return null; }
  const encText = encryptField(dk, "answer_bank_item.answer_text", text);
  // A question about this employer (previous employment, relatives, conflicts, or one naming it) is kept for this
  // employer only, under its words with the employer's name masked, so a rewording by the same employer still finds it
  // and no other employer's form ever gets it (Yong, 2026-11-21).
  const cat = questionCategory(label, opts.employer);
  const scoped = !!opts.employer && ((cat && EMPLOYER_CATEGORIES.has(cat)) || namesEmployer(label, opts.employer));
  if (scoped) {
    const ek = answerEmployerKey(opts.employer);
    const masked = normalQuestion(question, opts.employer);
    const mine = (await c.query("SELECT id, question_key, question_patterns FROM answer_bank_item WHERE employer_key = $1 ORDER BY id", [ek])).rows;
    const same = mine.find((x) => (cat && x.question_key === `employer:${cat}`) || (x.question_patterns as string[]).some((re) => { try { return new RegExp(re, "i").test(masked); } catch { return false; } }));
    let id: string;
    if (same) {
      await c.query("UPDATE answer_bank_item SET answer_text_enc = $2, status = 'approved', last_reviewed_at = now(), updated_at = now() WHERE id = $1", [same.id, encText]);
      id = same.id;
    } else {
      id = (await c.query(
        `INSERT INTO answer_bank_item (applicant_id, question_key, question_patterns, answer_text_enc, status, last_reviewed_at, is_applicant_step, employer_key)
         VALUES (app_applicant_id(), $1, $2, $3, 'approved', now(), false, $4) RETURNING id`,
        [cat ? `employer:${cat}` : `employer:${masked.slice(0, 80)}`, [`^${escapeRe(masked)}$`], encText, ek])).rows[0].id;
    }
    await recordAudit(c, "profile.answer_kept", { objectType: "applicant", objectId: applicantId, payload: { field: "question", where: "saved_answers_employer" } });
    return id;
  }
  const items = (await c.query("SELECT id, question_patterns FROM answer_bank_item WHERE NOT is_applicant_step AND employer_key IS NULL ORDER BY id")).rows;
  const same = items.find((x) => (x.question_patterns as string[]).some((re) => { try { return new RegExp(re, "i").test(label); } catch { return false; } }));
  let id: string;
  if (same) {
    await c.query("UPDATE answer_bank_item SET answer_text_enc = $2, status = 'approved', last_reviewed_at = now() WHERE id = $1", [same.id, encText]);
    id = same.id;
  } else {
    const preset = ANSWER_PRESETS.find((p) => !p.applicantStep && p.patterns.some((re) => new RegExp(re, "i").test(label)));
    const taken = preset ? (await c.query("SELECT 1 FROM answer_bank_item WHERE question_key = $1", [preset.key])).rowCount : 1;
    const [key, patterns] = preset && !taken ? [preset.key, [...preset.patterns]] : [`custom:${question.slice(0, 80)}`, [`^${escapeRe(question)}`]];
    id = (await c.query(
      `INSERT INTO answer_bank_item (applicant_id, question_key, question_patterns, answer_text_enc, status, last_reviewed_at, is_applicant_step)
       VALUES (app_applicant_id(), $1, $2, $3, 'approved', now(), false) RETURNING id`, [key, patterns, encText])).rows[0].id;
  }
  await recordAudit(c, "profile.answer_kept", { objectType: "applicant", objectId: applicantId, payload: { field: "question", where: "saved_answers" } });
  return id;
}

async function keepProfileDetail(c: pg.PoolClient, dk: Buffer, applicantId: string, field: ProfileField, v: string) {
  const enc = (col: string, x: string) => encryptField(dk, `applicant.${col}`, x);
  const a = (await c.query("SELECT legal_name_enc, preferred_name FROM applicant WHERE id = $1", [applicantId])).rows[0];
  const legal = a?.legal_name_enc ? decryptField(dk, "applicant.legal_name", a.legal_name_enc).trim().split(/\s+/).filter(Boolean) : [];
  const setName = (words: string[]) => c.query(
    "UPDATE applicant SET legal_name_enc = $2, preferred_name = CASE WHEN preferred_name IN ('', 'You') THEN $3 ELSE preferred_name END, updated_at = now() WHERE id = $1",
    [applicantId, enc("legal_name", words.join(" ")), words[0] ?? "You"]);
  switch (field) {
    case "first_name": await setName(legal.length > 1 ? [v, ...legal.slice(1)] : [v]); break;
    case "last_name": await setName(legal.length > 1 ? [...legal.slice(0, -1), v] : legal.length === 1 && legal[0] !== v ? [legal[0]!, v] : [v]); break;
    case "full_name": await setName(v.split(/\s+/)); break;
    case "preferred_name": await c.query("UPDATE applicant SET preferred_name = $2, updated_at = now() WHERE id = $1", [applicantId, v.slice(0, 100)]); break;
    case "email": await c.query("UPDATE applicant SET email_enc = $2, updated_at = now() WHERE id = $1", [applicantId, enc("email", v)]); break;
    case "phone": await c.query("UPDATE applicant SET phone_enc = $2, updated_at = now() WHERE id = $1", [applicantId, enc("phone", v)]); break;
    case "country": await c.query("UPDATE applicant SET country = $2, updated_at = now() WHERE id = $1", [applicantId, v.slice(0, 100)]); break;
    case "city": {
      const [city, region] = v.split(/,\s*/);
      await c.query("UPDATE applicant SET city = $2, region = coalesce($3, region), updated_at = now() WHERE id = $1", [applicantId, city!.slice(0, 100), region?.slice(0, 100) ?? null]);
      break;
    }
    case "linkedin": case "github": case "website":
      await c.query("UPDATE applicant SET links = links || $2::jsonb, updated_at = now() WHERE id = $1", [applicantId, JSON.stringify({ [field]: v })]);
      break;
  }
  await recordAudit(c, "profile.answer_kept", { objectType: "applicant", objectId: applicantId, payload: { field, where: "profile" } });
}

/**
 * A right-to-work or sponsorship question the applicant answered on an application: saved
 * (approved) as their saved answer for it, so every later form fills it from there (§13.7).
 */
export async function saveWorkAuthAnswer(pool: pg.Pool, cfg: AppConfig, session: Session, label: string, answer: string): Promise<void> {
  const text = answer.trim().slice(0, 500);
  if (!text) throw new DomainError("TC_BAD_INPUT");
  const preset = ANSWER_PRESETS.filter((p) => p.applicantStep).find((p) => p.patterns.some((re) => new RegExp(re, "i").test(label)))
    ?? ANSWER_PRESETS.find((p) => p.key === "work_auth")!;
  await withApplicant(pool, asApplicant(session), async (c) => {
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    const encText = encryptField(dk, "answer_bank_item.answer_text", text);
    const q = label.replace(/\s+/g, " ").replace(/[\s*:?]+$/, "").trim().slice(0, 200);
    const r = await c.query(
      `UPDATE answer_bank_item SET answer_text_enc = $2, status = 'approved', last_reviewed_at = now(),
         question_patterns = CASE WHEN $3 = ANY(question_patterns) THEN question_patterns ELSE question_patterns || $3 END
        WHERE question_key = $1 RETURNING id`, [preset.key, encText, `^${escapeRe(q)}`]);
    if (!r.rowCount) {
      await c.query(
        `INSERT INTO answer_bank_item (applicant_id, question_key, question_patterns, answer_text_enc, status, last_reviewed_at, is_applicant_step)
         VALUES (app_applicant_id(), $1, $2, $3, 'approved', now(), true)`, [preset.key, [...preset.patterns, `^${escapeRe(q)}`], encText]);
    }
    await recordAudit(c, "profile.answer_kept", { objectType: "applicant", objectId: session.applicantId, payload: { field: preset.key, where: "saved_answers" } });
  });
}

/**
 * Fills an empty About from the uploaded resume (Yong, 2026-11-17). The built-in rules first; when they
 * find nothing, Claude looks for the summary in the resume with contact details taken out, and only
 * text that is in the file word for word is kept. Without `force`, each uploaded file is looked at once
 * (Me calls this on every visit while the About is empty). True when an About was filled.
 */
export async function fillAboutFromResume(pool: pg.Pool, cfg: AppConfig, session: Session, opts: { finder?: AboutFinder; force?: boolean } = {}): Promise<boolean> {
  const who = asApplicant(session);
  const start = await withApplicant(pool, who, async (c) => {
    const a = (await c.query("SELECT about_enc, about_tried_file, preferred_name, legal_name_enc FROM applicant WHERE id = $1", [session.applicantId])).rows[0];
    if (!a || a.about_enc) return null;
    const file = (await c.query("SELECT id, kind, file_kind, content_enc FROM resume_file ORDER BY (kind = 'resume') DESC, created_at DESC LIMIT 1")).rows[0];
    if (!file || (!opts.force && a.about_tried_file === file.id)) return null;
    if ((await fillProfileFromResume(c, cfg, session.applicantId)).includes("about")) return "filled" as const;
    await c.query("UPDATE applicant SET about_tried_file = $2 WHERE id = $1", [session.applicantId, file.id]);
    if (!opts.finder || file.file_kind === "zip") return null;
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    let text = "";
    try { text = await extractText(file.file_kind as ResumeFileKind, open(dk, file.content_enc, "file:resume_file.content")); } catch { return null; }
    const legal = a.legal_name_enc ? decryptField(dk, "applicant.legal_name", a.legal_name_enc) : "";
    const names = [a.preferred_name, legal].filter((n: string) => n && n !== "You");
    return { text, sent: stripContactDetails(text, { names, firstSectionLine: contactBlockEnd(text) }), kind: file.kind as string };
  });
  if (start === "filled") return true;
  if (!start || !opts.finder) return false;
  // Outside any transaction: Claude can take a few seconds.
  const found = await opts.finder.find(start.sent);
  if (!found || !aboutIsInResume(found, start.text)) return false;
  return withApplicant(pool, who, async (c) => {
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    const r = await c.query("UPDATE applicant SET about_enc = $2, about_source = $3, about_updated_at = now(), updated_at = now() WHERE id = $1 AND about_enc IS NULL",
      [session.applicantId, encryptField(dk, "applicant.about", normaliseAbout(found)), start.kind === "linkedin" ? "linkedin" : "resume"]);
    if (r.rowCount) await recordAudit(c, "profile.filled_from_resume", { objectType: "applicant", objectId: session.applicantId, payload: { fields: "about" } });
    return (r.rowCount ?? 0) > 0;
  });
}
