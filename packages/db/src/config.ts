import { FileSecretStore, parseMasterKey, type SecretStore } from "@tc-hunter/domain";

export interface AppConfig {
  databaseUrl: string;
  masterKey: Buffer;
  sessionIdleMinutes: number;
  stepUpMinutes: number;
  allowSignup: boolean;
  /** The address people open the app at, e.g. https://tc-hunter.your-tailnet.ts.net. Passkeys are tied to it. */
  publicOrigin?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return {
    databaseUrl: env.DATABASE_URL,
    masterKey: parseMasterKey(env.TC_MASTER_KEY),
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES ?? 60),
    stepUpMinutes: Number(env.STEP_UP_MINUTES ?? 5),
    // Household server: sign-up is open only until both accounts exist, then the operator closes it.
    allowSignup: env.ALLOW_SIGNUP !== "false",
    publicOrigin: env.TC_PUBLIC_ORIGIN || undefined,
  };
}

/**
 * The employer-site password vault. Separate key and separate volume from the
 * database. First used in Phase 4b (account creation on employer sites).
 */
export function loadSecretStore(env: NodeJS.ProcessEnv = process.env): SecretStore {
  if (!env.TC_VAULT_DIR) throw new Error("TC_VAULT_DIR is not set");
  return new FileSecretStore(env.TC_VAULT_DIR, parseMasterKey(env.TC_VAULT_KEY));
}

/**
 * The resume reader (decision 13.6, Yong 2026-11-13): Claude with contact details
 * removed when an Anthropic key is configured, otherwise the built-in rule reader.
 */
export function resumeReaderName(env: NodeJS.ProcessEnv = process.env): "claude" | "rules" {
  return env.ANTHROPIC_API_KEY && env.TC_RESUME_READER !== "rules" ? "claude" : "rules";
}
