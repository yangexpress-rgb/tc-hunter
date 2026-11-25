import { createHash, randomInt } from "node:crypto";

/**
 * Invitation codes (brief 2026-11-25): 12 characters from an alphabet with no
 * look-alikes (no I, L, O, 0 or 1), shown in three groups of four for typing,
 * e.g. "K7QM-W2XH-9RTB". About 59 bits: guessing one is hopeless, and each code
 * also works only with the email it was made for.
 */
export const INVITE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const INVITE_CODE_LENGTH = 12;
export const INVITE_DAYS = 7;

export function newInviteCode(): string {
  const chars = Array.from({ length: INVITE_CODE_LENGTH }, () => INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)]).join("");
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** What a person typed, as the stored form of an invitation code, or null if it can't be one. */
export function normaliseInviteCode(input: string): string | null {
  const c = input.trim().toUpperCase().replace(/[\s-]/g, "");
  if (c.length !== INVITE_CODE_LENGTH) return null;
  for (const ch of c) if (!INVITE_ALPHABET.includes(ch)) return null;
  return c;
}

/** The only thing the database keeps: the SHA-256 (hex) of the normalised code. */
export function inviteCodeHash(normalised: string): string {
  return createHash("sha256").update(normalised).digest("hex");
}

/** Emails are compared the way accounts store them. */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}
