/**
 * Layer 1 message catalogue (brief 2.1). All plain-language text the applicant
 * sees by default comes from here. Tests fail the build if a banned technical
 * word appears, or if any Tim Cook / Apple reference appears beyond the tagline
 * (brand rule, brief v1.1).
 */
export const BRAND = {
  name: "TC Hunter",
  tagline: "Get hired. Rise like Tim Cook.",
} as const;

export const BANNED_LAYER1_WORDS = ["API", "token", "OAuth", "MCP", "scraper", "selector", "endpoint", "webhook"] as const;

export const L1 = {
  // Sign-in
  "signin.title": "Sign in",
  "signin.cta": "Sign in",
  "signin.code_prompt": "Enter the 6-digit code from your authenticator app.",
  "signin.failed": "That email and password don't match. Try again.",
  "signin.code_failed": "That code didn't work. Check your authenticator app and try again.",
  "signin.expired": "You were signed out after a while without activity. Please sign in again.",
  "signup.title": "Create your account",
  "signup.cta": "Create account",
  "signup.closed": "New accounts are closed on this server. Ask the person who runs it to add you.",
  "signup.password_too_short": "Use at least 12 characters for your password.",
  "signup.password_contains_email": "Pick a password that doesn't include your email name.",
  "signup.password_too_simple": "Pick a password with more variety in it.",
  "signup.email_taken": "There's already an account with that email.",
  "signout.cta": "Sign out",
  "stepup.prompt": "For your safety, confirm it's you before approving this submission.",
  "stepup.needed": "Please confirm it's you, then try again.",

  // Home
  "home.welcome": "Welcome, {name}",
  "home.next_action.profile": "Start by building your profile",
  "home.next_action.profile_soon": "Your profile tools arrive in the next update.",
  "home.tile.new_matches": "New matches today",
  "home.tile.in_progress": "Applications in progress",
  "home.tile.follow_ups": "Follow-ups due",
  "home.tile.interviews": "Interviews upcoming",
  "home.tile.gaps": "Top skill gaps",
  "home.tile.empty": "Nothing yet",

  // Settings
  "settings.title": "Settings",
  "settings.mfa.title": "Two-step sign-in",
  "settings.mfa.off": "Two-step sign-in is off. Turn it on to protect your account.",
  "settings.mfa.on": "Two-step sign-in is on.",
  "settings.mfa.setup": "Add this key to your authenticator app (or open the link on your phone), then enter the 6-digit code it shows.",
  "settings.mfa.enable_cta": "Turn on two-step sign-in",
  "settings.mfa.confirm_cta": "Confirm",
  "settings.advanced": "Advanced",
  "settings.privacy": "Only you can see your information. Nobody else on this server, including other family members, can open it.",

  // Layer controls
  "layer.details": "Details",
  "layer.advanced": "Advanced",

  // Packet states, plain equivalents (brief 5.5)
  "packet.packet_draft": "Getting your application ready",
  "packet.packet_ready_for_review": "Ready to apply — review & approve",
  "packet.approved_to_apply": "Approved — ready to start",
  "packet.filling": "Filling in the form",
  "packet.waiting_for_applicant.sign_in": "This employer site needs you to sign in — your turn.",
  "packet.waiting_for_applicant.verification": "This employer site paused for a sign-in check — your turn.",
  "packet.waiting_for_applicant.attestation": "This step needs your own confirmation — your turn.",
  "packet.waiting_for_applicant.unknown_field": "One question needs your answer — your turn.",
  "packet.waiting_for_applicant.site_blocked": "This employer site stopped us from continuing. You can finish it yourself.",
  "packet.ready_to_submit": "Ready to submit — approve to send",
  "packet.submitted": "Applied on {date}",
  "packet.submitted_no_ref": "Submitted — no confirmation number was shown",
  "packet.failed": "This application didn't go through.",
  "packet.failed.outcome_unknown": "We couldn't confirm this application went through. Please check the employer's site before trying again.",
  "packet.outcome.went_through": "It went through",
  "packet.outcome.did_not": "It didn't",
  "packet.abandoned": "You stopped this application",
  "packet.your_step": "Your step",

  // Application stages, plain equivalents (brief 5.6)
  "stage.interested": "Interested",
  "stage.tailoring": "Preparing your resume",
  "stage.ready_to_apply": "Ready to apply",
  "stage.applied": "Applied",
  "stage.screening": "Being screened",
  "stage.interview": "Interviewing",
  "stage.offer": "Offer",
  "stage.closed_won": "Accepted",
  "stage.closed_lost": "Not selected",
  "stage.withdrawn": "Withdrawn",
  "stage.no_response": "No reply",

  // Sources
  "source.blocked": "This source isn't available right now",

  // Errors (every error code maps to one of these)
  "error.generic": "Something went wrong on our side. Your information is safe. Please try again.",
  "error.not_found": "We couldn't find that. It may have been removed.",
  "error.document_locked": "This version is approved and can't be changed. Make a new version instead.",
  "error.diff_not_viewed": "Look over the changes before you approve this version.",
  "error.approval_stale": "Something changed since you approved this. Please review it again.",
  "error.already_applied": "You've already applied to this job, or we're still checking whether the last attempt went through.",
  "error.not_yours_to_approve": "Only you can approve your own applications.",
  "error.stage_conflict": "We noticed a possible update to this application. Check it and decide.",
  "error.needs_your_answer": "We need you to tell us what happened before going further.",
  "error.proficiency": "Only you can set how strong a skill is.",
} as const;

export type L1Key = keyof typeof L1;

export function t(key: L1Key, vars: Record<string, string> = {}): string {
  return L1[key].replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? "");
}

/** Every database and domain error code maps to a plain Layer 1 sentence. */
export const ERROR_MESSAGES: Record<string, L1Key> = {
  TC_DOCUMENT_IMMUTABLE: "error.document_locked",
  TC_DOCUMENT_MUST_START_DRAFT: "error.generic",
  TC_DOCUMENT_DRAFT_CANNOT_BE_SUPERSEDED: "error.generic",
  TC_DOCUMENT_NO_HASH: "error.generic",
  TC_DIFF_NOT_VIEWED: "error.diff_not_viewed",
  TC_APPROVAL_NOT_APPLICANT: "error.not_yours_to_approve",
  TC_APPROVAL_STALE: "error.approval_stale",
  TC_PACKET_DOCUMENT_NOT_APPROVED: "error.approval_stale",
  TC_PACKET_MUST_START_DRAFT: "error.generic",
  TC_PACKET_BAD_TRANSITION: "error.generic",
  TC_PACKET_CLOSED: "error.already_applied",
  TC_ALREADY_SUBMITTED_OR_UNKNOWN: "error.already_applied",
  TC_OUTCOME_UNKNOWN_NEEDS_APPLICANT: "error.needs_your_answer",
  TC_SUBMIT_NOT_APPROVED: "error.not_yours_to_approve",
  TC_SUBMISSION_KEY_USED: "error.already_applied",
  TC_STAGE_NOT_APPLICANT: "error.not_yours_to_approve",
  TC_STAGE_NOT_FORWARD: "error.stage_conflict",
  TC_STAGE_CONFLICT: "error.stage_conflict",
  TC_STAGE_UNCHANGED: "error.generic",
  TC_PROFICIENCY_NOT_APPLICANT_STATED: "error.proficiency",
  TC_VERIFY_NOT_APPLICANT: "error.not_yours_to_approve",
  TC_IMPORT_MUST_BE_DRAFT: "error.generic",
  TC_AUDIT_SECRET_KEY: "error.generic",
  TC_AUDIT_APPEND_ONLY: "error.generic",
  TC_NOT_FOUND: "error.not_found",
  TC_STEP_UP_REQUIRED: "stepup.needed",
};

/** Layer 1 sentence for any error. Technical detail belongs in Layer 3 only. */
export function plainError(code: string | undefined): string {
  return t(ERROR_MESSAGES[code ?? ""] ?? "error.generic");
}

/** Pull a TC_ code out of a database error message. */
export function errorCode(err: unknown): string | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  return /\b(TC_[A-Z_]+)\b/.exec(msg)?.[1];
}
