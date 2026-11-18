import { ANSWER_MODEL, aiModels, FileSecretStore, type AiProvider, INFER_EFFORT, parseMasterKey, type SecretStore } from "@tc-hunter/domain";

export interface AppConfig {
  databaseUrl: string;
  masterKey: Buffer;
  sessionIdleMinutes: number;
  /** Days a "remember this device" sign-in lasts. 0 turns the option off. */
  rememberDeviceDays: number;
  stepUpMinutes: number;
  allowSignup: boolean;
  /**
   * When set, creating an account needs this code (shared only with the household).
   * On a public host (Railway) sign-up stays closed unless a code is set.
   */
  signupCode?: string;
  /** Every account must turn on two-step sign-in before using the app. On by default. */
  requireMfa: boolean;
  /** The address people open the app at, e.g. https://tc-hunter.your-tailnet.ts.net. Passkeys are tied to it. */
  publicOrigin?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  return {
    databaseUrl: env.DATABASE_URL,
    masterKey: parseMasterKey(env.TC_MASTER_KEY),
    sessionIdleMinutes: Number(env.SESSION_IDLE_MINUTES ?? 60),
    rememberDeviceDays: Math.max(0, Math.min(90, Number(env.REMEMBER_DEVICE_DAYS ?? 30) || 0)),
    stepUpMinutes: Number(env.STEP_UP_MINUTES ?? 5),
    // Household server: sign-up is open only until both accounts exist, then the operator closes it.
    allowSignup: env.ALLOW_SIGNUP !== "false" && (!onPublicHost(env) || Boolean(env.SIGNUP_CODE)),
    signupCode: env.SIGNUP_CODE || undefined,
    requireMfa: env.REQUIRE_MFA !== "false",
    publicOrigin: env.TC_PUBLIC_ORIGIN || undefined,
  };
}

/** Running on a public host (Railway sets RAILWAY_ENVIRONMENT_NAME; TC_PUBLIC_HOST=true for any other). */
export function onPublicHost(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.RAILWAY_ENVIRONMENT_NAME || env.RAILWAY_ENVIRONMENT) || env.TC_PUBLIC_HOST === "true";
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

/**
 * Whether application questions are worked out by Claude ("smart answers", Yong 2026-11-17), in
 * plain words for Settings and the worker's startup log. When off, the reason; never silent.
 */
export function smartAnswersStatus(env: NodeJS.ProcessEnv = process.env, provider: AiProvider = "claude"): { on: boolean; provider: AiProvider; model: string | null; effort: string; problem: string | null } {
  const off = (problem: string) => ({ on: false, provider, model: null, effort: INFER_EFFORT, problem });
  if (provider === "claude" && !env.ANTHROPIC_API_KEY) return off("No Anthropic API key is set on the server (ANTHROPIC_API_KEY on Railway), so questions the rules can't settle are left for you.");
  if (env.TC_RESUME_READER === "rules") return off("Claude is turned off on the server (TC_RESUME_READER=rules), so questions the rules can't settle are left for you.");
  if (env.TC_ANSWER_INFER === "off") return off("Smart answers are turned off on the server (TC_ANSWER_INFER=off), so questions the rules can't settle are left for you.");
  if (env.TC_APPLY_BROWSER === "off") return off("TC Hunter's own browser is turned off on the server (TC_APPLY_BROWSER=off), so it doesn't fill in forms.");
  return { on: true, provider, model: provider === "claude" ? ANSWER_MODEL : aiModels(env).openai.judgment, effort: INFER_EFFORT, problem: null };
}
