import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { Report } from "./reports";

/** CSV with a guard against spreadsheet formulas (a cell starting with = + - @ is read as text). */
export function reportCsv(r: Report): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [r.columns.map((c) => cell(c.label)).join(","), ...r.rows.map((row) => r.columns.map((c) => cell(row[c.key])).join(","))].join("\r\n") + "\r\n";
}

const safe = (s: string) => [...s].map((ch) => { const c = ch.codePointAt(0)!; return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || "–—‘’“”•…".includes(ch) ? ch : "?"; }).join("");

/** A plain one-table PDF of a report. */
export async function reportPdf(r: Report, subtitle: string, when: Date): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`TC Hunter ${r.title} report`); doc.setCreator("TC Hunter"); doc.setProducer("TC Hunter");
  doc.setCreationDate(when); doc.setModificationDate(when);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const wide = r.columns.length > 5;
  const W = wide ? 792 : 612, H = wide ? 612 : 792, M = 48;
  let page = doc.addPage([W, H]);
  let y = H - M;
  const colW = (W - 2 * M) / r.columns.length;
  const fit = (s: string, f: typeof reg, size: number) => { let t = safe(s); while (t.length > 1 && f.widthOfTextAtSize(t, size) > colW - 6) t = t.slice(0, -2) + "…"; return t; };
  const header = () => {
    r.columns.forEach((c, i) => page.drawText(fit(c.label, bold, 9), { x: M + i * colW, y, size: 9, font: bold }));
    page.drawLine({ start: { x: M, y: y - 4 }, end: { x: W - M, y: y - 4 }, thickness: 0.6, color: rgb(0.5, 0.5, 0.5) });
    y -= 18;
  };
  page.drawText(safe(`${r.title} report`), { x: M, y: y - 16, size: 18, font: bold }); y -= 34;
  page.drawText(safe(subtitle), { x: M, y, size: 10, font: reg, color: rgb(0.35, 0.35, 0.35) }); y -= 14;
  page.drawText(safe(r.intro), { x: M, y, size: 10, font: reg }); y -= 24;
  header();
  for (const row of r.rows) {
    if (y < M + 20) { page = doc.addPage([W, H]); y = H - M; header(); }
    r.columns.forEach((c, i) => page.drawText(fit(row[c.key] === null || row[c.key] === undefined ? "–" : String(row[c.key]), reg, 9.5), { x: M + i * colW, y, size: 9.5, font: reg }));
    y -= 15;
  }
  if (r.note) { y -= 10; if (y < M) { page = doc.addPage([W, H]); y = H - M; } page.drawText(safe(r.note), { x: M, y, size: 10, font: reg }); }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
