import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Field-level encryption (brief 2.5). Envelope scheme:
 *   master key (env TC_MASTER_KEY, 32 bytes) wraps each applicant's own data key;
 *   the data key encrypts that applicant's sensitive columns (the *_enc columns).
 * Yong's and Leo's fields are encrypted under different keys.
 * Format: version(1) | iv(12) | tag(16) | ciphertext.
 */
const VERSION = 1;

export function parseMasterKey(b64: string | undefined): Buffer {
  if (!b64) throw new Error("TC_MASTER_KEY is not set");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("TC_MASTER_KEY must be 32 bytes, base64-encoded");
  return key;
}

export function seal(key: Buffer, plaintext: Buffer | string, aad = ""): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ct]);
}

export function open(key: Buffer, sealed: Buffer, aad = ""): Buffer {
  if (sealed[0] !== VERSION) throw new Error("unknown ciphertext version");
  const iv = sealed.subarray(1, 13);
  const tag = sealed.subarray(13, 29);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
}

/** A fresh data key for a new applicant, returned wrapped by the master key. */
export function newWrappedDataKey(masterKey: Buffer, applicantLabel: string): Buffer {
  return seal(masterKey, randomBytes(32), `applicant-data-key:${applicantLabel}`);
}

export function unwrapDataKey(masterKey: Buffer, wrapped: Buffer, applicantLabel: string): Buffer {
  return open(masterKey, wrapped, `applicant-data-key:${applicantLabel}`);
}

/** Encrypt one column value. The AAD binds it to its table and column, so values cannot be swapped. */
export function encryptField(dataKey: Buffer, column: string, value: string): Buffer {
  return seal(dataKey, value, `field:${column}`);
}

export function decryptField(dataKey: Buffer, column: string, sealed: Buffer): string {
  return open(dataKey, sealed, `field:${column}`).toString("utf8");
}
