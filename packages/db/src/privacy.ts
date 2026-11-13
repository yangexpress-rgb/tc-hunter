import type pg from "pg";
import { decryptField, writeZip, type SecretStore } from "@tc-hunter/domain";
import { recordAudit } from "./audit";
import { hasFreshStepUp, type Session } from "./auth";
import type { AppConfig } from "./config";
import { withApplicant } from "./context";
import { APPLICANT_OWNED_TABLES } from "./owned";
import { DomainError } from "./packets";
import { asApplicant, dataKeyFor } from "./profile";

/**
 * Export and delete-my-data (brief 8, design 2.5). Both are started by the
 * applicant, from Settings, and both are audit-logged.
 *
 * The export holds everything TC Hunter keeps about the applicant, readable,
 * with encrypted fields opened. It never includes secrets: no sign-in password
 * hash, no authenticator seed, no data keys, and nothing from the employer-site
 * vault (not even its references).
 */
const NEVER_EXPORT = /^(password_hash|mfa_secret_enc|data_key_wrapped|vault_ref|token_hash|submission_key)$/;

export interface ExportBundle { json: Record<string, unknown>; zip: Buffer; fileName: string }

export async function exportMyData(pool: pg.Pool, cfg: AppConfig, session: Session): Promise<ExportBundle> {
  return withApplicant(pool, asApplicant(session), async (c) => {
    const dk = await dataKeyFor(c, cfg, session.applicantId);
    const open = (table: string, row: Record<string, unknown>) => {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(row)) {
        if (NEVER_EXPORT.test(k) || k === "applicant_id") continue;
        if (k.endsWith("_enc")) {
          const name = k.replace(/_enc$/, "");
          if (!v) { out[name] = null; continue; }
          try { out[name] = decryptField(dk, `${table}.${name}`, v as Buffer); } catch { out[name] = "[could not be opened]"; }
          continue;
        }
        out[k] = Buffer.isBuffer(v) ? v.toString("base64") : v;
      }
      return out;
    };
    await recordAudit(c, "data.exported", { objectType: "applicant", objectId: session.applicantId, payload: { format: "zip" } });
    const me = (await c.query("SELECT * FROM applicant WHERE id = $1", [session.applicantId])).rows[0];
    const account = (await c.query("SELECT email, mfa_enabled, created_at FROM user_account WHERE id = $1", [session.userAccountId])).rows[0];
    const passkeys = (await c.query("SELECT label, created_at, last_used_at FROM passkey_credential")).rows;
    const data: Record<string, unknown> = {
      exported_at: new Date().toISOString(),
      account: { ...account, passkeys },
      applicant: open("applicant", me),
    };
    for (const t of [...APPLICANT_OWNED_TABLES, "import_batch"]) {
      if (t === "request_key") continue;
      const rows = (await c.query(`SELECT * FROM ${t} WHERE applicant_id = $1 ORDER BY created_at`, [session.applicantId])).rows;
      data[t] = rows.map((r) => open(t, r));
    }
    // Stories are stored as one encrypted JSON blob; give them back as readable fields.
    data.story_bank_item = (data.story_bank_item as Array<Record<string, unknown>>).map((s) => {
      let story: unknown = s.story;
      try { story = typeof s.story === "string" ? JSON.parse(s.story) : s.story; } catch { /* keep as text */ }
      return { ...s, story };
    });
    const docs = (data.document as Array<Record<string, unknown>>) ?? [];
    const readme = [
      "TC Hunter: your data export",
      "",
      "profile.json holds everything TC Hunter keeps about you, with encrypted fields opened.",
      "documents/ holds each document version's editable content.",
      "Not included, by design: your sign-in password, your two-step key, and the employer-site passwords in your vault.",
      "",
    ].join("\n");
    const zip = writeZip([
      { name: "README.txt", data: Buffer.from(readme) },
      { name: "profile.json", data: Buffer.from(JSON.stringify(data, null, 2)) },
      ...docs.map((d) => ({ name: `documents/${d.public_ref}-v${d.version}.json`, data: Buffer.from(JSON.stringify(d.source_json, null, 2)) })),
    ]);
    const day = new Date().toISOString().slice(0, 10);
    return { json: data, zip, fileName: `tc-hunter-export-${day}.zip` };
  });
}

/**
 * Deletes everything for the signed-in applicant: the account, every row, the
 * audit log, sessions, passkeys and the employer-site vault. Needs a fresh
 * sign-in check (within the step-up window) and the applicant's own email typed
 * as confirmation. Cannot be undone.
 */
export async function eraseMyData(pool: pg.Pool, cfg: AppConfig, session: Session, vault: SecretStore, typedEmail: string): Promise<void> {
  if (!hasFreshStepUp(session, cfg)) throw new DomainError("TC_STEP_UP_REQUIRED");
  if (typedEmail.trim().toLowerCase() !== session.email.toLowerCase()) throw new DomainError("TC_ERASE_CONFIRM_MISMATCH");
  await withApplicant(pool, asApplicant(session), (c) => c.query("SELECT erase_my_data()"));
  // The database is the record of truth; the vault goes once the rows are gone.
  await vault.destroyVault(session.applicantId);
}
