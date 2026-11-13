/**
 * Turns an uploaded resume file into plain text, on the server. Supported: PDF,
 * DOCX and plain text. The file itself is not kept (documents storage arrives in
 * Phase 3); only the draft rows the applicant then checks are saved.
 */
export type ResumeFileKind = "pdf" | "docx" | "text";

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;

export function detectKind(name: string, bytes: Uint8Array): ResumeFileKind | null {
  if (bytes.length >= 4 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46) return "pdf"; // %PDF
  if (bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b && /\.docx$/i.test(name)) return "docx";               // PK zip
  if (/\.(txt|md)$/i.test(name)) return "text";
  return null;
}

export async function extractText(kind: ResumeFileKind, bytes: Uint8Array): Promise<string> {
  if (kind === "text") return new TextDecoder("utf-8").decode(bytes);
  if (kind === "docx") {
    const mammoth = await import("mammoth");
    const r = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
    return r.value;
  }
  const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const r = await pdfText(pdf, { mergePages: true });
  return Array.isArray(r.text) ? r.text.join("\n") : r.text;
}
