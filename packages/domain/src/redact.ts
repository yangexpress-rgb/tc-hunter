import { SecretValue } from "./secretStore";

/**
 * Shared logger with redaction (brief 2.4, 2.5). Anything whose key looks like
 * a secret or personal data is replaced before it is written. Secret values are
 * also never present as plain strings: they travel as SecretValue.
 */
const SECRET_KEY = /(pass(word)?|secret|token|cookie|session|otp|mfa|authorization|api[-_]?key|credential|vault_value)/i;
const PII_KEY = /(^|_)(email|phone|legal_name|name|address|street|postcode|zip|dob|birth|ssn|national_id|answer|answer_value|notes|work_auth\w*|salary_expectation)($|_)/i;

export const REDACTED = "[redacted]";

export function redact(value: unknown, depth = 0): unknown {
  if (value instanceof SecretValue) return REDACTED;
  if (depth > 8) return "[deep]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (Buffer.isBuffer(value)) return `[bytes:${value.length}]`;
  if (value && typeof value === "object") {
    if (value instanceof Error) return { error: value.name, code: (value as { code?: string }).code };
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) || PII_KEY.test(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export type LogSink = (line: string) => void;

export interface Logger {
  info(event: string, fields?: Record<string, unknown>): void;
  warn(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

export function createLogger(sink: LogSink = (l) => process.stdout.write(l + "\n")): Logger {
  const write = (level: string, event: string, fields?: Record<string, unknown>) =>
    sink(JSON.stringify({ at: new Date().toISOString(), level, event, ...(redact(fields ?? {}) as object) }));
  return {
    info: (e, f) => write("info", e, f),
    warn: (e, f) => write("warn", e, f),
    error: (e, f) => write("error", e, f),
  };
}
