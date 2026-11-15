"use server";
import { redirect } from "next/navigation";
import { APP_SETTINGS, saveAppSetting, settingsEnv } from "@tc-hunter/db";
import { errorCode, PoliteFetcher, searchSites, SourceRefusedError } from "@tc-hunter/domain";
import { app, log, requireSession } from "@/lib/server";

/** Saves what was typed: a blank box keeps a saved key as it is; a ticked "Remove" clears it. */
async function saveTyped(form: FormData): Promise<void> {
  const s = await requireSession();
  const { pool, cfg } = app();
  const remove = new Set(form.getAll("remove").map(String));
  for (const { name } of APP_SETTINGS) {
    const v = String(form.get(name) ?? "").trim();
    if (v) await saveAppSetting(pool, cfg, s, name, v);
    else if (remove.has(name)) await saveAppSetting(pool, cfg, s, name, "");
  }
}

export async function saveSiteKeysAction(form: FormData): Promise<void> {
  let target = "/settings?saved=1#job-sites";
  try { await saveTyped(form); } catch (e) { target = `/settings?e=${errorCode(e) ?? "TC_UNKNOWN"}#job-sites`; }
  redirect(target);
}

/** Runs one small search on a job site with the keys as they stand now, and says plainly how it went. */
export async function testSiteAction(form: FormData): Promise<void> {
  try { await saveTyped(form); } catch (e) { redirect(`/settings?e=${errorCode(e) ?? "TC_UNKNOWN"}#job-sites`); }
  const { pool, cfg } = app();
  const id = String(form.get("site") ?? "");
  const site = searchSites(await settingsEnv(pool, cfg, process.env)).sites.find((x) => x.id === id);
  let result: string;
  if (!site) result = "missing";
  else {
    try {
      const jobs = await site.search({ what: "project manager", where: null, remote: false }, new PoliteFetcher({ perHostMs: 0, timeoutMs: 20000 }));
      result = `ok-${jobs.length}`;
    } catch (e) {
      // Never echo the error text: a site's address can carry the key.
      result = e instanceof SourceRefusedError ? e.reason : "broken";
      log.warn("settings.site_test_failed", { site: id, reason: result });
    }
  }
  redirect(`/settings?test=${encodeURIComponent(id)}&result=${encodeURIComponent(result)}#job-sites`);
}
