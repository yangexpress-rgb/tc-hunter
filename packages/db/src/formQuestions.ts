import type pg from "pg";
import type { FormField } from "@tc-hunter/domain";

/**
 * Collect, then fill; ask once (Phase 3, Yong 2026-11-21). An employer's form asks the same questions of
 * everyone, so the questions each page showed (labels and choices only, never answers) are remembered per
 * form. A later application to that employer asks them all before it types anything: one "Needs you" list
 * at the start, not a stop on page 3 and another on page 5.
 *
 * Workday checks each page before it shows the next, so its later pages can't be read without filling the
 * earlier ones. What is remembered is what earlier runs on the same form saw; a question one of the employer's
 * jobs asked and another doesn't may be asked up front anyway (answering it does no harm: an answer to a
 * question this form doesn't show is never typed anywhere).
 */

export function formKey(ats: string, tenant: string | null | undefined): string | null {
  return tenant ? `${ats}:${tenant.toLowerCase()}` : null;
}

/** Keep what a page asked. Follow-up questions (opened by an answer) are not passed in: they depend on the answer. */
export async function rememberFormQuestions(pool: pg.Pool, key: string | null, page: number, title: string | null, fields: FormField[], postingId: string): Promise<void> {
  if (!key || !fields.length) return;
  const c = await pool.connect();
  try {
    for (const f of fields) {
      if (!f.key || !f.label) continue;
      await c.query(
        `INSERT INTO form_question (form_key, page, field_key, label, field_type, options, required, page_title, site_filled, job_posting_ids, last_seen_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, ARRAY[$10::uuid], now())
         ON CONFLICT (form_key, page, field_key) DO UPDATE SET label = EXCLUDED.label, field_type = EXCLUDED.field_type, options = EXCLUDED.options,
           required = EXCLUDED.required, page_title = EXCLUDED.page_title, site_filled = EXCLUDED.site_filled, last_seen_at = now(),
           job_posting_ids = CASE WHEN $10::uuid = ANY(form_question.job_posting_ids) THEN form_question.job_posting_ids
                                  ELSE (ARRAY[$10::uuid] || form_question.job_posting_ids)[1:20] END`,
        [key, page, f.key, f.label.slice(0, 500), f.type, f.options ? JSON.stringify(f.options.slice(0, 200)) : null, !!f.required, title, !!f.hasValue, postingId]);
    }
  } finally {
    c.release();
  }
}

/**
 * The questions to ask before filling: everything earlier runs saw on this form, keyed as the run keys them
 * ("p2|…"). Questions the site filled itself are returned as prefilled.
 */
export async function rememberedQuestions(pool: pg.Pool, key: string | null): Promise<{ fields: FormField[]; prefilled: Set<string> }> {
  const prefilled = new Set<string>();
  if (!key) return { fields: [], prefilled };
  const rows = (await pool.query(
    `SELECT page, field_key, label, field_type, options, required, site_filled FROM form_question
      WHERE form_key = $1
      ORDER BY page, last_seen_at, field_key`, [key])).rows;
  const fields = rows.map((r) => {
    const k = `p${r.page}|${r.field_key}`;
    if (r.site_filled) prefilled.add(k);
    return { key: k, label: r.label, type: r.field_type, required: r.required, ...(r.options ? { options: r.options as string[] } : {}) } as FormField;
  });
  return { fields, prefilled };
}
