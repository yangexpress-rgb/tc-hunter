import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from "pdf-lib";
import { writeZip } from "../zip";
import type { LetterSource, ResumeSource } from "./types";

/**
 * ATS-simple exports (design 5.4): one column, standard fonts, real text, no tables,
 * images or text boxes. Contact details are passed in at export time from the
 * encrypted profile; they are not part of the approved content.
 */
export interface DocHeader { name: string; email?: string | null; phone?: string | null; place?: string | null; links?: string[] }

type Block =
  | { t: "name"; text: string } | { t: "contact"; text: string } | { t: "heading"; text: string }
  | { t: "role"; left: string; right: string } | { t: "sub"; text: string } | { t: "bullet"; text: string }
  | { t: "para"; text: string } | { t: "gap" };

const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthYear(d: string | null): string {
  if (!d) return "Present";
  const [y, m] = d.split("-");
  return m ? `${MONTH[Number(m) - 1]} ${y}` : y!;
}

const contactLine = (h: DocHeader) => [h.place, h.email, h.phone, ...(h.links ?? [])].filter(Boolean).join("  |  ");

function resumeBlocks(s: ResumeSource, h: DocHeader): Block[] {
  const b: Block[] = [{ t: "name", text: h.name }];
  const c = contactLine(h);
  if (c) b.push({ t: "contact", text: c });
  const items = s.experience.filter((i) => i.included);
  if (items.length) {
    b.push({ t: "heading", text: "Experience" });
    for (const i of items) {
      b.push({ t: "role", left: i.title, right: `${monthYear(i.start)} – ${monthYear(i.end)}` });
      const sub = [i.employer, i.location].filter(Boolean).join(", ");
      if (sub) b.push({ t: "sub", text: sub });
      for (const l of i.lines.filter((x) => x.included)) b.push({ t: "bullet", text: l.text });
      b.push({ t: "gap" });
    }
  }
  const skills = s.skills.filter((x) => x.included).map((x) => x.name);
  if (skills.length) { b.push({ t: "heading", text: "Skills" }, { t: "para", text: skills.join(", ") }, { t: "gap" }); }
  if (s.education.length) {
    b.push({ t: "heading", text: "Education" });
    for (const e of s.education) {
      b.push({ t: "role", left: [e.degree, e.field].filter(Boolean).join(", ") || e.institution, right: e.end ? monthYear(e.end) : "" });
      if (e.degree || e.field) b.push({ t: "sub", text: [e.institution, e.honours].filter(Boolean).join(", ") });
    }
    b.push({ t: "gap" });
  }
  if (s.credentials.length) {
    b.push({ t: "heading", text: "Certifications" });
    for (const c2 of s.credentials) b.push({ t: "bullet", text: [c2.name, c2.issuer, c2.issuedOn ? c2.issuedOn.slice(0, 4) : null].filter(Boolean).join(", ") });
  }
  return b;
}

function letterBlocks(s: LetterSource, h: DocHeader, date: Date): Block[] {
  const b: Block[] = [{ t: "name", text: h.name }];
  const c = contactLine(h);
  if (c) b.push({ t: "contact", text: c });
  b.push({ t: "gap" }, { t: "para", text: date.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) }, { t: "gap" });
  b.push({ t: "para", text: `Dear ${s.target.employer} hiring team,` }, { t: "gap" });
  for (const p of s.paragraphs.filter((x) => x.included)) b.push({ t: "para", text: p.text }, { t: "gap" });
  b.push({ t: "para", text: "Sincerely," }, { t: "para", text: h.name });
  return b;
}

// Standard PDF fonts only cover Windows-1252; anything else is replaced rather than dropped silently.
const WIN_EXTRA = new Set("€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ");
const safe = (s: string) => [...s.normalize("NFC")].map((ch) => {
  const c = ch.codePointAt(0)!;
  return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_EXTRA.has(ch) ? ch : ch === "\t" ? " " : "?";
}).join("");

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const w of text.split(/\s+/)) {
    const next = line ? `${line} ${w}` : w;
    if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
    else { out.push(line); line = w; }
  }
  if (line) out.push(line);
  return out;
}

async function toPdf(blocks: Block[], title: string, when: Date): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(title); doc.setCreator("TC Hunter"); doc.setProducer("TC Hunter");
  doc.setCreationDate(when); doc.setModificationDate(when);
  const reg = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 54, IW = W - 2 * M;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;
  const need = (h: number) => { if (y - h < M) { page = doc.addPage([W, H]); y = H - M; } };
  const text = (s: string, x: number, size: number, f: PDFFont) => page.drawText(safe(s), { x, y, size, font: f, color: rgb(0.1, 0.1, 0.1) });
  for (const b of blocks) {
    switch (b.t) {
      case "name": need(26); y -= 20; text(b.text, M, 20, bold); y -= 8; break;
      case "contact": for (const l of wrap(safe(b.text), reg, 9.5, IW)) { need(13); y -= 12; text(l, M, 9.5, reg); } y -= 4; break;
      case "heading":
        need(26); y -= 16; text(b.text.toUpperCase(), M, 11, bold);
        page.drawLine({ start: { x: M, y: y - 3 }, end: { x: W - M, y: y - 3 }, thickness: 0.6, color: rgb(0.5, 0.5, 0.5) }); y -= 6; break;
      case "role": {
        need(16); y -= 14; text(b.left, M, 10.5, bold);
        if (b.right) { const rw = reg.widthOfTextAtSize(safe(b.right), 10); text(b.right, W - M - rw, 10, reg); }
        break;
      }
      case "sub": need(14); y -= 12.5; text(b.text, M, 10, reg); break;
      case "bullet":
        wrap(safe(b.text), reg, 10, IW - 14).forEach((l, i) => { need(14); y -= 13; if (i === 0) text("•", M + 3, 10, reg); text(l, M + 14, 10, reg); });
        break;
      case "para": for (const l of wrap(safe(b.text), reg, 10.5, IW)) { need(15); y -= 14; text(l, M, 10.5, reg); } break;
      case "gap": y -= 6; break;
    }
  }
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const run = (t: string, o: { b?: boolean; sz?: number } = {}) =>
  `<w:r><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/>${o.b ? "<w:b/>" : ""}<w:sz w:val="${o.sz ?? 21}"/></w:rPr><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
const para = (inner: string, o: { after?: number; before?: number; indent?: number; tab?: boolean; border?: boolean } = {}) =>
  `<w:p><w:pPr>${o.border ? '<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="808080"/></w:pBdr>' : ""}` +
  `${o.tab ? '<w:tabs><w:tab w:val="right" w:pos="9360"/></w:tabs>' : ""}<w:spacing w:before="${o.before ?? 0}" w:after="${o.after ?? 40}"/>` +
  `${o.indent ? `<w:ind w:left="${o.indent}" w:hanging="220"/>` : ""}</w:pPr>${inner}</w:p>`;

function toDocx(blocks: Block[], title: string, when: Date): Buffer {
  const body = blocks.map((b) => {
    switch (b.t) {
      case "name": return para(run(b.text, { b: true, sz: 36 }), { after: 60 });
      case "contact": return para(run(b.text, { sz: 19 }), { after: 120 });
      case "heading": return para(run(b.text.toUpperCase(), { b: true, sz: 22 }), { before: 160, after: 60, border: true });
      case "role": return para(run(b.left, { b: true }) + (b.right ? `<w:r><w:tab/></w:r>${run(b.right)}` : ""), { tab: true, before: 80, after: 0 });
      case "sub": return para(run(b.text), { after: 20 });
      case "bullet": return para(run(`• ${b.text}`), { indent: 360, after: 20 });
      case "para": return para(run(b.text, { sz: 22 }), { after: 60 });
      case "gap": return para("", { after: 40 });
    }
  }).join("");
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="0" w:footer="0" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const iso = when.toISOString().replace(/\.\d+Z$/, "Z");
  return writeZip([
    { name: "[Content_Types].xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`) },
    { name: "_rels/.rels", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`) },
    { name: "docProps/core.xml", data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>TC Hunter</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${iso}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${iso}</dcterms:modified></cp:coreProperties>`) },
    { name: "word/document.xml", data: Buffer.from(document) },
  ]);
}

export interface Rendered { pdf: Buffer; docx: Buffer; fileBase: string }

const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "document";

/** Renders both formats. `when` fixes the document dates so the same version renders the same file. */
export async function renderDocument(source: ResumeSource | LetterSource, header: DocHeader, when: Date): Promise<Rendered> {
  const isLetter = source.kind === "letter";
  const blocks = isLetter ? letterBlocks(source, header, when) : resumeBlocks(source, header);
  const title = `${header.name} - ${isLetter ? "Cover letter" : "Resume"} - ${source.target.employer}`;
  return {
    pdf: await toPdf(blocks, title, when),
    docx: toDocx(blocks, title, when),
    fileBase: fileSafe(`${header.name} ${isLetter ? "Cover letter" : "Resume"} ${source.target.employer}`),
  };
}
