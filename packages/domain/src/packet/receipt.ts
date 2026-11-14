import { PDFDocument, rgb, StandardFonts } from "pdf-lib";

/** Application receipt (P11): one page from the record of what was sent. Kept by the applicant, never sent anywhere. */
export interface ReceiptData {
  applicant: string; employer: string; title: string; jobRef: string; applicationRef: string;
  submittedAt: Date; timeZone: string; confirmationRef: string | null;
  resume: string; letter: string | null;
  answers: Array<{ question: string; answer: string; source: string }>;
}

const SOURCE: Record<string, string> = {
  master_profile: "your profile", answer_bank: "your saved answer", tailored_doc: "your approved document", applicant_typed: "typed by you", applicant_step: "your own step",
};
const safe = (s: string) => [...s].map((ch) => { const c = ch.codePointAt(0)!; return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || "–—‘’“”•…".includes(ch) ? ch : "?"; }).join("");

export async function receiptPdf(r: ReceiptData): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Application receipt ${r.applicationRef}`); doc.setCreator("TC Hunter"); doc.setProducer("TC Hunter");
  doc.setCreationDate(r.submittedAt); doc.setModificationDate(r.submittedAt);
  const reg = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 54;
  let page = doc.addPage([W, H]); let y = H - M;
  const line = (text: string, o: { size?: number; font?: typeof reg; gap?: number; color?: number } = {}) => {
    const size = o.size ?? 10, font = o.font ?? reg;
    const words = safe(text).split(" "); let cur = "";
    const flush = () => { if (y < M) { page = doc.addPage([W, H]); y = H - M; } page.drawText(cur, { x: M, y, size, font, color: rgb(o.color ?? 0, o.color ?? 0, o.color ?? 0) }); y -= size + 4; cur = ""; };
    for (const w of words) { const next = cur ? `${cur} ${w}` : w; if (font.widthOfTextAtSize(next, size) > W - 2 * M && cur) { flush(); cur = w; } else cur = next; }
    if (cur) flush();
    y -= o.gap ?? 0;
  };
  const when = new Intl.DateTimeFormat("en-GB", { timeZone: r.timeZone, dateStyle: "long", timeStyle: "short" }).format(r.submittedAt);
  line("Application receipt", { size: 18, font: bold, gap: 6 });
  line(`${r.title} at ${r.employer}`, { size: 12, font: bold });
  line(`Applicant: ${r.applicant}`);
  line(`Submitted: ${when} (${r.timeZone})`);
  line(r.confirmationRef ? `Confirmation number: ${r.confirmationRef}` : "Submitted: no confirmation number was shown", { gap: 8 });
  line("Documents sent", { size: 12, font: bold });
  line(`Resume: ${r.resume}`);
  line(r.letter ? `Cover letter: ${r.letter}` : "Cover letter: none", { gap: 8 });
  line("Answers", { size: 12, font: bold });
  for (const a of r.answers) {
    line(a.question, { font: bold });
    line(`${a.answer}  (${SOURCE[a.source] ?? a.source})`, { gap: 4 });
  }
  y -= 6;
  line(`Application ${r.applicationRef} · job ${r.jobRef}. Made by TC Hunter from its record of this application.`, { size: 8, color: 0.4 });
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}
