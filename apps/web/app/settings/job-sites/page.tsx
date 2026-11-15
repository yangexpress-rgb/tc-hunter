import { listAppSettings } from "@tc-hunter/db";
import { searchSites } from "@tc-hunter/domain";
import { requireSession, app } from "@/lib/server";
import { flashOf, type PageProps } from "@/lib/profile";
import { saveSiteKeysAction, testSiteAction } from "../sites-actions";
import { SettingsHeader } from "../shared";

export const dynamic = "force-dynamic";

/** Settings › Job sites: the free keys for the job-search sites. Household-wide. */
export default async function JobSitesSettingsPage(props: PageProps) {
  await requireSession();
  const { pool } = app();
  const { saved, error, params } = await flashOf(props);
  const keys = (await listAppSettings(pool)).filter((k) => k.site !== "google");
  const siteOn = new Map(searchSites(Object.fromEntries(keys.map((k) => [k.name, k.saved || k.fromRailway ? "x" : undefined]))).status.map((x) => [x.id, x.on]));
  const SITES = [
    { id: "adzuna", name: "Adzuna", covers: "Jobs from many job boards, Indeed and LinkedIn listings among them", signup: "https://developer.adzuna.com/signup" },
    { id: "jooble", name: "Jooble", covers: "Jobs from many job boards", signup: "https://jooble.org/api/about" },
    { id: "usajobs", name: "USAJOBS", covers: "US federal government jobs", signup: "https://developer.usajobs.gov/apirequest/" },
  ];
  const test = params.test ? { site: params.test, result: params.result ?? "" } : null;
  const testText = (r: string) => r.startsWith("ok-") ? `It works: a test search found ${r.slice(3)} job${r === "ok-1" ? "" : "s"}.`
    : r === "missing" ? "Not tried: a key is still missing."
    : r === "refused" ? "The site said no. The key is probably wrong or not active yet."
    : r === "rate_limited" ? "The site is busy or the key's daily limit is used up. Try again later."
    : r === "unreachable" ? "Couldn't reach the site, or it didn't answer with jobs. Try again in a minute."
    : "The test didn't work. Check the key and try again.";
  return (
    <>
      <SettingsHeader title="Job sites" params={params} saved={saved} error={error} />
      <section className="card" id="job-sites">
        <h2>Job search sites</h2>
        <p>Keys for the job sites the app searches. They're free. Saved keys are locked with the app's own key, never shown again in full, and used from the next search on. Test saves what you typed, then runs a small search.</p>
        <form action={saveSiteKeysAction}>
          {/* Pressing Enter in a box saves, rather than pressing the first Test button. */}
          <button className="sr-only" tabIndex={-1} aria-hidden="true">Save keys</button>
          {SITES.map((site) => (
            <fieldset key={site.id}>
              <legend>{site.name} <span className="muted">· {site.covers}</span> {siteOn.get(site.id as never) ? <span className="ok">On</span> : <span className="warn">Off</span>}</legend>
              {keys.filter((k) => k.site === site.id).map((k) => (
                <label key={k.name}>{k.label}
                  <span className="muted small"> {k.saved ? `· saved, ends in ${k.tail}` : k.fromRailway ? "· set on Railway" : "· not set"}</span>
                  <input name={k.name} type={k.name === "USAJOBS_EMAIL" ? "email" : "password"} autoComplete="off" placeholder={k.saved || k.fromRailway ? "Leave blank to keep" : ""} />
                  {k.saved ? <span className="small"><input type="checkbox" name="remove" value={k.name} /> Remove the saved key</span> : null}
                </label>
              ))}
              <p className="small">
                <a href={site.signup} target="_blank" rel="noreferrer">Get a free key</a>
                {" · "}<button className="small secondary" formAction={testSiteAction} name="site" value={site.id} formNoValidate>Test {site.name}</button>
              </p>
              {test?.site === site.id ? <p className={test.result.startsWith("ok-") ? "ok" : "error"}>{testText(test.result)}</p> : null}
            </fieldset>
          ))}
          <button>Save keys</button>
        </form>
      </section>

    </>
  );
}
