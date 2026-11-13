/**
 * Builds the F1 sample resume as PDF and DOCX from fixtures/f1/sample-resume.txt,
 * so the import test covers all three upload formats. Run: npx tsx scripts/make-f1-fixtures.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { writeZip } from "../packages/domain/src/zip.ts";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "f1");
const lines = readFileSync(join(dir, "sample-resume.txt"), "utf8").replace(/\n$/, "").split("\n");

async function pdf() {
  const doc = await PDFDocument.create();
  doc.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  doc.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let page = doc.addPage([612, 792]);
  let y = 750;
  for (const line of lines) {
    if (y < 50) { page = doc.addPage([612, 792]); y = 750; }
    page.drawText(line, { x: 50, y, size: 10, font });
    y -= 14;
  }
  writeFileSync(join(dir, "sample-resume.pdf"), await doc.save({ useObjectStreams: false }));
}

function docx() {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const body = lines.map((l) => `<w:p><w:r><w:t xml:space="preserve">${esc(l)}</w:t></w:r></w:p>`).join("");
  const files = {
    "[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    "_rels/.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  };
  writeFileSync(join(dir, "sample-resume.docx"), writeZip(Object.entries(files).map(([name, s]) => ({ name, data: Buffer.from(s) }))));
}

await pdf();
docx();
console.log("wrote sample-resume.pdf and sample-resume.docx");
