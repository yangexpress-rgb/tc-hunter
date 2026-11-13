import { hash, verify } from "@node-rs/argon2";

/** The app's own sign-in password. Employer-site passwords never pass through here (they go to the vault). */
const OPTIONS = { algorithm: 2 /* Argon2id */, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const MIN_PASSWORD_LENGTH = 12;

export function passwordProblem(pw: string, email: string): string | null {
  if (pw.length < MIN_PASSWORD_LENGTH) return "password_too_short";
  if (pw.toLowerCase().includes(email.split("@")[0]!.toLowerCase())) return "password_contains_email";
  if (new Set(pw).size < 6) return "password_too_simple";
  return null;
}

export function hashPassword(pw: string): Promise<string> {
  return hash(pw, OPTIONS);
}

export function verifyPassword(stored: string, pw: string): Promise<boolean> {
  return verify(stored, pw).catch(() => false);
}
