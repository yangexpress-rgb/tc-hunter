"use server";
import { redirect } from "next/navigation";
import { approveDocument, confirmAlias, editDocument, newVersion, requestTailor, type DocKind, type EditOp } from "@tc-hunter/db";
import { errorCode } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";

/** Only ever send people back to a Documents or Jobs page. */
function backTo(form: FormData, fallback: string): string {
  const b = String(form.get("back") ?? "");
  return /^\/(documents|jobs)(\/[A-Za-z0-9-]*)?(\?[a-z=&0-9_-]*)?(#[a-z0-9-]*)?$/.test(b) ? b : fallback;
}
const withParam = (path: string, k: string, v: string) => {
  const [base, hash] = path.split("#");
  return `${base}${base!.includes("?") ? "&" : "?"}${k}=${encodeURIComponent(v)}${hash ? `#${hash}` : ""}`;
};

async function act(form: FormData, fn: () => Promise<unknown>, fallback: string, ok = "saved"): Promise<never> {
  const back = backTo(form, fallback);
  let target = withParam(back, ok, "1");
  try { await fn(); } catch (e) {
    const code = errorCode(e) ?? "TC_UNKNOWN";
    log.warn("documents.action_failed", { code });
    target = withParam(back, "e", code);
  }
  redirect(target);
}

const int = (form: FormData, k: string) => Number.parseInt(String(form.get(k) ?? ""), 10);

export async function tailorAction(form: FormData) {
  const s = await requireSession();
  const job = String(form.get("job") ?? "");
  const kinds = form.getAll("kind").map(String).filter((k): k is DocKind => k === "resume" || k === "letter");
  await act(form, () => requestTailor(app().pool, s, job, kinds.length ? kinds : ["resume", "letter"]), `/jobs/${job}`, "preparing");
}

export async function editAction(form: FormData) {
  const s = await requireSession();
  const op = String(form.get("op"));
  const dir = (form.get("dir") === "-1" ? -1 : 1) as -1 | 1;
  const text = String(form.get("text") ?? "").slice(0, 1000);
  const e: EditOp | null =
    op === "toggle_line" ? { op, item: int(form, "item"), line: int(form, "line") }
    : op === "move_line" ? { op, item: int(form, "item"), line: int(form, "line"), dir }
    : op === "edit_line" ? { op, item: int(form, "item"), line: int(form, "line"), text }
    : op === "use_original" ? { op, item: int(form, "item"), line: int(form, "line") }
    : op === "toggle_item" ? { op, item: int(form, "item") }
    : op === "toggle_skill" ? { op, skillId: String(form.get("skill")) }
    : op === "move_skill" ? { op, skillId: String(form.get("skill")), dir }
    : op === "toggle_para" ? { op, para: int(form, "para") }
    : op === "move_para" ? { op, para: int(form, "para"), dir }
    : op === "edit_para" ? { op, para: int(form, "para"), text }
    : null;
  const { pool, cfg } = app();
  await act(form, async () => { if (!e) throw new Error("TC_BAD_INPUT"); await editDocument(pool, cfg, s, String(form.get("doc")), e); }, "/documents");
}

export async function approveAction(form: FormData) {
  const s = await requireSession();
  const { pool, cfg } = app();
  await act(form, () => approveDocument(pool, cfg, s, String(form.get("doc"))), "/documents", "approved");
}

export async function newVersionAction(form: FormData) {
  const s = await requireSession();
  let ref = "";
  try { ref = await newVersion(app().pool, s, String(form.get("doc"))); } catch (e) {
    redirect(withParam(backTo(form, "/documents"), "e", errorCode(e) ?? "TC_UNKNOWN"));
  }
  redirect(`/documents/${ref}`);
}

export async function confirmAliasAction(form: FormData) {
  const s = await requireSession();
  await act(form, () => confirmAlias(app().pool, s, String(form.get("blocked"))), "/documents");
}
