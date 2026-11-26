import { describe, expect, it } from "vitest";
import { ADAPTERS, SERVER_APPLY_ATS, SourceRefusedError, detectAts, fetchSource, findOnEmployerSite, formUrlFor, isPinpointPage, isPinpointPosting, looksConfirmed, pickSameJob, readPinpointList, type FetchOpts, type Fetcher } from "../src";

/**
 * Pinpoint careers sites (Align Technology, 2026-11-26): the "Vice President, Platform Engineering"
 * application stopped with "jobs.aligntech.com isn't a hiring site TC Hunter can apply on by itself yet".
 * jobs.aligntech.com runs on Pinpoint: each job at /en/postings/{uuid}, its one-page form at
 * /applications/new, and the whole job list at /postings.json.
 */

const HOME = "https://jobs.aligntech.com/";
const VP_SJ = "https://jobs.aligntech.com/en/postings/14d29eb2-d36a-4ef6-8383-329d603d83ae";
const VP_NC = "https://jobs.aligntech.com/en/postings/ea717b50-1197-4d51-90e3-5a757cd7e783";
const HOME_HTML = `<html><head><link rel="icon" href="https://res.cloudinary.com/pinpointhq/image/upload/c_fill/v1/uploads/x.png"></head><body><a href="/search-job">Jobs</a></body></html>`;

const job = (id: string, url: string, title: string, place: string, req = "ALGN-32421") => ({
  id, url, path: new URL(url).pathname, title, workplace_type: "onsite", description: "<div>The VP leads the platform.</div>",
  key_responsibilities: "<ul><li>Own the platform strategy</li></ul>", compensation_visible: "true", compensation_minimum: "297300",
  compensation_maximum: "408800", compensation_currency: "USD", compensation_frequency: "year",
  location: { name: place, city: place.split("-").at(-1) }, job: { id: "603636", requisition_id: req },
});
const LIST = { data: [
  job("604182", VP_SJ, "Vice President, Platform Engineering", "US-California-San Jose"),
  job("607044", VP_NC, "Vice President, Platform Engineering", "US-North Carolina-Raleigh"),
  job("285349", "https://jobs.aligntech.com/en/postings/002e2499-7539-4997-a85a-5e698667f7f3", "Sales Training Manager", "US-North Carolina-Raleigh", "ALGN-30000"),
] };

function site(pages: Record<string, unknown>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(url: string, _opts?: FetchOpts) {
      calls.push(url);
      if (/linkedin|indeed/.test(url)) throw new Error("fetched a job site");
      const body = pages[url];
      if (body === undefined) throw new SourceRefusedError("not_found", url);
      return { status: 200, text: typeof body === "string" ? body : JSON.stringify(body), url, contentType: "text/html" };
    },
  };
}

describe("Pinpoint careers sites (Align Technology)", () => {
  it("knows a Pinpoint job and its form on the employer's own address", () => {
    expect(isPinpointPosting(VP_SJ)).toBe(true);
    expect(isPinpointPosting(`${VP_SJ}/applications/new`)).toBe(true);
    expect(detectAts(VP_SJ)).toBe("pinpoint");
    expect(detectAts("https://acme.pinpointhq.com/en/postings/whatever")).toBe("pinpoint");
    expect(detectAts(HOME)).toBe("other");
    expect(detectAts("https://jobs.aligntech.com/en/postings/not-a-uuid")).toBe("other");
    expect(SERVER_APPLY_ATS).toContain("pinpoint");
  });

  it("opens the job's own form, and leaves the form's address as it is", () => {
    expect(formUrlFor("pinpoint", VP_SJ)).toBe(`${VP_SJ}/applications/new`);
    expect(formUrlFor("pinpoint", `${VP_SJ}/applications/new`)).toBe(`${VP_SJ}/applications/new`);
  });

  it("presses only the form's own Submit, and knows the thank-you", () => {
    expect(ADAPTERS.pinpoint.submit).toContain("form[action$='/applications']");
    expect(looksConfirmed("pinpoint", `${VP_SJ}/applications/new`, "Thank you for your application! We'll be in touch.")).toBe(true);
    expect(looksConfirmed("pinpoint", `${VP_SJ}/applications/new`, "Submit Application. Save application for later")).toBe(false);
  });

  it("reads the whole job list, with pay and requisition IDs", () => {
    expect(isPinpointPage(HOME_HTML)).toBe(true);
    expect(isPinpointPage("<html>Workday</html>")).toBe(false);
    const all = readPinpointList(LIST, "Align Technology", HOME);
    expect(all).toHaveLength(3);
    expect(all[0]).toMatchObject({ url: VP_SJ, applyUrl: `${VP_SJ}/applications/new`, title: "Vice President, Platform Engineering", locationRaw: "US-California-San Jose",
      workplaceType: "onsite", atsType: "pinpoint", reqIds: ["ALGN-32421"], salary: { min: 297300, max: 408800, currency: "USD", period: "year" } });
    expect(all[0]!.descriptionText).toContain("Own the platform strategy");
  });

  it("reads a Pinpoint careers page through its job list", async () => {
    const f = site({ [HOME]: HOME_HTML, "https://jobs.aligntech.com/postings.json": LIST });
    const r = await fetchSource({ type: "careers_page", kind: "careers_page", key: "https://jobs.aligntech.com", name: "Align Technology", url: HOME }, f, () => true, 10);
    expect(r.postings.map((p) => p.title)).toContain("Vice President, Platform Engineering");
    expect(r.complete).toBe(true);
  });

  it("picks the posting in the job's own place when the same job is listed in two", () => {
    const all = readPinpointList(LIST, "Align Technology", HOME);
    const pick = pickSameJob({ employer: "Align Technology", title: "Vice President, Platform Engineering", location: "San Jose, CA" }, all);
    expect(pick.posting?.url).toBe(VP_SJ);
  });

  it("finds the job from LinkedIn on the remembered careers site, in No AI mode", async () => {
    const f = site({ [HOME]: HOME_HTML, "https://jobs.aligntech.com/postings.json": LIST });
    const r = await findOnEmployerSite({ employer: "Align Technology", title: "Vice President, Platform Engineering", location: "Raleigh, NC" }, f,
      { known: { type: "careers_page", kind: "careers_page", key: "https://jobs.aligntech.com", name: "Align Technology", url: HOME } });
    expect(r.found).toBe(true);
    if (r.found) expect(r.url).toBe(`${VP_NC}/applications/new`);
    expect(f.calls.some((u) => /linkedin|indeed/.test(u))).toBe(false);
  });
});
