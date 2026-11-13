import { createHash } from "node:crypto";

/** Canonical JSON: object keys sorted at every level, so equal content hashes equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export interface PacketFingerprintInput {
  jobPostingId: string;
  tailoredResume: { id: string; contentHash: string };
  coverLetter?: { id: string; contentHash: string } | null;
  fields: Array<{
    ordinal: number;
    question: string;
    /** Plain answer text. Hashed here, never stored in the fingerprint input. */
    answer: string | null;
    source: string | null;
    requiresApplicantStep: boolean;
  }>;
}

/**
 * The fingerprint an approval binds to (Risk 4, point 2): the job, the exact
 * document versions and every answer. Any change gives a different hash, which
 * voids the approval.
 */
export function packetFingerprint(input: PacketFingerprintInput): string {
  const fields = [...input.fields]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((f) => ({ ...f, answer: f.answer === null ? null : sha256Hex(f.answer) }));
  return sha256Hex(canonicalJson({ v: 1, ...input, fields }));
}
