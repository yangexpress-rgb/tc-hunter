import { describe, expect, it } from "vitest";
import { SourceRefusedError, detectJobLink, detectSource, fetchSource, findOnEmployerSite, parseAdp, readAdpJob, type Fetcher } from "../src";

/**
 * ADP Workforce Now career centers (BioIVT, 2026-11-23): BioIVT's careers page links to its ADP career
 * center, which TC Hunter didn't know, so a BioIVT job from LinkedIn ended with "couldn't find BioIVT's
 * careers site". These run in No AI mode: no careers lookup is passed.
 */

const CID = "e9d00ee9-dafd-403f-a173-21148e663d66";
const BOARD = `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}&ccId=19000101_000001&lang=en_US`;
const API = "https://workforcenow.adp.com/mascsr/default/careercenter/public/events/staffing/v1/job-requisitions";
const Q = `cid=${CID}&ccId=19000101_000001&lang=en_US&locale=en_US`;

const row = (n: number, title: string, place = " Durham, NC, US") => ({
  itemID: `92013_${n}`, clientRequisitionID: String(2000 + n), postDate: "2026-11-21T02:27:00", requisitionTitle: title,
  requisitionLocations: [{ nameCode: { shortName: place } }],
});

function sites(pages: Record<string, unknown>): Fetcher & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async get(url: string) {
      calls.push(url);
      if (/linkedin|indeed/.test(url)) throw new Error("fetched a job site");
      const body = pages[url];
      if (body === undefined) throw new SourceRefusedError("not_found", url);
      return { status: 200, text: typeof body === "string" ? body : JSON.stringify(body), url, contentType: "application/json" };
    },
  };
}

/** BioIVT as it is: www.bioivt.com/careers links to its ADP career center; 21 jobs listed, 20 a page. */
function bioivt(extra: unknown[] = []) {
  const jobs = [...Array.from({ length: 20 }, (_, i) => row(i + 1, `Phlebotomy Technician ${i + 1}`)), row(21, "Scientist I"), ...extra];
  return {
    "https://www.bioivt.com/careers": `<html><a href="/">Home</a><a href="https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${CID}&amp;ccId=19000101_000001&amp;lang=en_US">View open positions</a></html>`,
    [`${API}?${Q}&$top=20&$skip=0`]: { meta: { totalNumber: jobs.length }, jobRequisitions: jobs.slice(0, 20) },
    [`${API}?${Q}&$top=20&$skip=20`]: { meta: { totalNumber: jobs.length }, jobRequisitions: jobs.slice(20, 40) },
    ...Object.fromEntries(jobs.map((j) => [`${API}/${(j as { itemID: string }).itemID}?${Q}`, { ...(j as object), requisitionDescription: "<p>About the role</p>" }])),
  };
}

describe("ADP career centers", () => {
  it("are read from their addresses, the board and one job", () => {
    expect(parseAdp(BOARD)).toEqual({ cid: CID, ccId: "19000101_000001", jobId: null });
    expect(parseAdp(`${BOARD.replace(/&/g, "&amp;")}&amp;jobId=92013_66`)?.jobId).toBe("92013_66");
    expect(parseAdp("https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=nope")).toBeNull();
    expect(detectSource(BOARD, "BioIVT")).toMatchObject({ kind: "adp", key: CID, name: "BioIVT", url: BOARD });
    expect(detectJobLink(`${BOARD}&jobId=92013_66`)).toMatchObject({ kind: "adp", board: CID, id: "92013_66" });
  });

  it("a job reads its title, place, requisition ID and its own address", () => {
    const p = readAdpJob({ ...row(66, "Scientist I"), requisitionDescription: "<p>Work on site</p>" }, { cid: CID, ccId: "19000101_000001" }, "BioIVT");
    expect(p).toMatchObject({ title: "Scientist I", locationRaw: "Durham, NC, US", reqIds: ["2066"], atsType: "adp", employer: "BioIVT" });
    expect(p.url).toBe(`${BOARD.replace("&lang=en_US", "")}&jobId=92013_66&lang=en_US`);
    expect(p.descriptionText).toContain("Work on site");
  });

  it("the whole list is read, 20 a page", async () => {
    const r = await fetchSource({ type: "ats_api", kind: "adp", key: CID, name: "BioIVT", url: BOARD }, sites(bioivt()), (t) => /scientist/i.test(t));
    expect(r.listed).toBe(21);
    expect(r.postings.find((p) => p.title === "Scientist I")?.descriptionText).toContain("About the role");
  });
});

describe("the link hunt finds an employer's ADP career center (No AI)", () => {
  it("from its careers page, and applies on the same job there", async () => {
    const f = sites(bioivt([row(30, "Vice President, Information Technology", " Remote US, US")]));
    const r = await findOnEmployerSite({ employer: "BioIVT", title: "Vice President, Information Technology", location: "Philadelphia, PA" }, f);
    expect(r.found).toBe(true);
    if (!r.found) return;
    expect(r.spec?.kind).toBe("adp");
    expect(r.url).toContain("jobId=92013_30");
  });

  it("says the job isn't listed there, not that the careers site couldn't be found", async () => {
    const r = await findOnEmployerSite({ employer: "BioIVT", title: "Vice President, Information Technology", location: null }, sites(bioivt()));
    expect(r.found).toBe(false);
    if (r.found) return;
    expect(r.failure).toBe("job_not_listed");
    expect(r.spec?.kind).toBe("adp");
    expect(r.reason).toMatch(/isn't on BioIVT's careers site \(workforcenow\.adp\.com\) now/);
  });

  it("a remembered ADP board is searched first", async () => {
    const f = sites(bioivt([row(31, "Vice President, Information Technology")]));
    const r = await findOnEmployerSite({ employer: "BioIVT", title: "Vice President, Information Technology", location: "Durham, NC" }, f,
      { known: { type: "ats_api", kind: "adp", key: CID, name: "BioIVT", url: BOARD } });
    expect(r.found).toBe(true);
    expect(f.calls.some((u) => u.includes("bioivt.com"))).toBe(false);
  });
});
