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
  "home.next_action.profile_soon": "Bring in your resume, or add your experience by hand.",
  "home.next_action.review": "Check your imported rows",
  "home.next_action.preferences": "Tell us what jobs you want",
  "home.next_action.improve": "Strengthen your profile",
  "home.next_action.done": "Your profile is in good shape",
  "home.next_action.done_note": "We'll tell you here when new jobs match you.",
  "home.coach.title": "To make your profile stronger",

  // Profile (Module A)
  "profile.title": "My profile",
  "profile.checked": "Checked",
  "profile.draft": "Needs your check",
  "profile.check_cta": "This is right",
  "profile.import.title": "Bring in your resume",
  "profile.import.intro": "Upload your resume (PDF, Word or text) or your LinkedIn data download. Everything comes in as a draft for you to check, row by row. Nothing counts until you say it's right.",
  "profile.import.done": "We read {n} rows from your file. Please check each one.",
  "profile.import.unreadable": "We couldn't read that file. Try a PDF, a Word document, or your LinkedIn data download.",
  "profile.import.too_big": "That file is too big. Please use one under 5 MB.",
  "profile.import.privacy": "Your name, email, phone and address are removed before your resume is read. The file itself isn't kept.",
  "profile.review.title": "Check your imported rows",
  "profile.review.empty": "Nothing waiting for your check.",
  "profile.review.discard": "Remove the rows from this file that I haven't checked",
  "profile.experience.title": "Experience",
  "profile.experience.hint": "Jobs, internships, projects, volunteering and coursework all count.",
  "profile.education.title": "Education",
  "profile.skills.title": "Skills",
  "profile.skills.no_proof": "No proof yet. Link it to something you did so it counts in matching.",
  "profile.credentials.title": "Certifications and licences",
  "profile.answers.title": "Saved answers",
  "profile.answers.hint": "Answers you approve here can be reused word for word on applications. Anything not approved is only a draft.",
  "profile.answers.stale": "Not reviewed in 90 days. Check it's still right before it's used again.",
  "profile.answers.your_step": "Always your step: we'll show this answer, but you answer it yourself on each application.",
  "profile.stories.title": "Your stories",
  "profile.stories.hint": "Short stories about things you did: the situation, your task, what you did and the result. Each one must be tied to something in your experience.",
  "profile.preferences.title": "What you're looking for",
  "profile.saved": "Saved.",

  // Settings, Phase 1
  "settings.passkeys.title": "Passkeys",
  "settings.passkeys.intro": "Sign in with your phone or laptop's fingerprint, face or PIN instead of a password.",
  "settings.passkeys.add": "Add a passkey",
  "settings.passkeys.unavailable": "Passkeys need the server's web address to be set. Ask the person who runs it.",
  "settings.passkeys.added": "Passkey added.",
  "settings.passkeys.failed": "That didn't work. Please try again.",
  "settings.confirm.title": "Confirm it's you",
  "settings.confirm.cta": "Confirm",
  "settings.confirm.intro": "Adding a passkey or deleting your data needs a fresh check that it's you.",
  "settings.confirm.failed": "That didn't match. Please try again.",
  "settings.confirm.done": "Thanks, you're confirmed for the next few minutes.",
  "settings.confirm.passkey_cta": "Confirm with a passkey",
  "settings.export.title": "Download my data",
  "settings.export.intro": "Everything TC Hunter keeps about you, in one file you can open. It never includes your passwords.",
  "settings.export.cta": "Download my data",
  "settings.delete.title": "Delete my data",
  "settings.delete.intro": "This permanently deletes your account and everything in it, including your saved employer-site passwords. It can't be undone. Download your data first if you want a copy.",
  "settings.delete.cta": "Delete everything",
  "settings.delete.type_email": "Type your email to confirm",
  "signin.passkey_cta": "Sign in with a passkey",
  "signin.passkey_failed": "That passkey didn't work here. Try again, or use your password.",
  "home.next_action.sources": "Choose where to look for jobs",
  "home.next_action.sources_note": "Follow a few companies' job pages and we'll check them every day.",
  "home.next_action.matches": "{n} new jobs match you well",
  "home.next_action.alerts": "A job you saved has changed",
  "home.alerts.title": "Changes to jobs you saved",

  // Jobs (Phase 2)
  "jobs.title": "Jobs",
  "jobs.scan_cta": "Look for jobs now",
  "jobs.scanning": "Looking for jobs now. This page updates when it's done.",
  "jobs.never_scanned": "We haven't looked for jobs yet.",
  "jobs.no_sources": "Choose companies to follow, and we'll look for jobs there every day.",
  "jobs.empty": "No new jobs match you right now. We'll keep looking.",
  "jobs.save": "Save",
  "jobs.pass": "Pass",
  "jobs.not_a_fit": "Not a fit",
  "jobs.undo": "Put back",
  "jobs.gaps.title": "Skills to show or build",
  "jobs.gaps.hint": "Missing from your profile, or listed without proof. We never add these to anything for you.",
  "jobs.adjust.title": "How your choices change this list",
  "jobs.adjust.none": "Nothing yet. When you pass on several similar jobs, we'll show them lower and tell you here.",
  "jobs.closed": "This job has closed.",
  "jobs.sources.title": "Where we look",
  "jobs.sources.intro": "Paste the address of a company's jobs page. We read the jobs it lists, politely and at a gentle pace, and never sign in anywhere.",
  "jobs.sources.unavailable": "This source isn't available right now.",
  "jobs.sources.trouble": "We had trouble reaching this last time. We'll try again.",
  "jobs.sources.ok": "Working",
  "jobs.paste.title": "Add a job by its link",
  "jobs.paste.intro": "Found a job somewhere else? Paste its address and we'll read and score it for you.",
  "jobs.paste.no_fetch": "We don't open LinkedIn, Indeed and similar sites automatically. For those, paste the job's title, employer and text below too.",
  "jobs.paste.reading": "Reading that job. This page updates when it's done.",

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
  "error.fact_locked": "You've checked this, so only you can change it.",
  "error.story_fact": "Link this story to something in your own experience.",
  "error.fields": "Some of that doesn't fit. Check the dates and required fields and try again.",
  "error.source": "We can't read jobs from that address. Use a company's careers or jobs page address that starts with https.",
  "error.erase_confirm": "That email doesn't match your account, so nothing was deleted.",
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
  TC_VERIFIED_FACT_LOCKED: "error.fact_locked",
  TC_STORY_FACT_NOT_YOURS: "error.story_fact",
  TC_STORY_NEEDS_FACT: "error.story_fact",
  TC_FIELD_NOT_EDITABLE: "error.generic",
  TC_PASSKEYS_NOT_SET_UP: "settings.passkeys.unavailable",
  TC_ERASE_CONFIRM_MISMATCH: "error.erase_confirm",
  TC_BAD_INPUT: "error.fields",
  TC_STEP_UP_FAILED: "settings.confirm.failed",
  TC_SOURCE_NOT_SUPPORTED: "error.source",
};

/** Layer 1 sentence for any error. Technical detail belongs in Layer 3 only. */
export function plainError(code: string | undefined): string {
  return t(ERROR_MESSAGES[code ?? ""] ?? "error.generic");
}

/** Pull a TC_ code out of a database error message. Bad input (checks, dates, types) reads as TC_BAD_INPUT. */
export function errorCode(err: unknown): string | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  const tc = /\b(TC_[A-Z_]+)\b/.exec(msg)?.[1];
  if (tc) return tc;
  const pg = (err as { code?: string } | null)?.code;
  if (pg && /^(22|23502|23514)/.test(pg)) return "TC_BAD_INPUT";
  return undefined;
}
