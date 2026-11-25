/**
 * Audit log payload allow-list (brief 5.6). Each action may record only these
 * keys. Never passwords, never full personal data: for submissions, the
 * employer, job, document versions and where each answer came from.
 */
export const AUDIT_ALLOWED_KEYS = {
  "account.created": ["method"],
  "session.signed_in": ["mfa_used", "method"],
  "session.signed_out": [],
  "session.step_up": ["method"],
  "mfa.enabled": [],
  "mfa.disabled": ["reason"],
  "mfa.recovery_codes_made": [],
  "mfa.moved": [],
  "session.locked": ["minutes"],
  "session.remembered": ["days"],
  "session.ended_elsewhere": ["count"],
  "document.approved": ["document_ref", "type", "version", "content_hash"],
  "document.generated": ["document_ref", "type", "version", "proposer", "blocked"],
  "document.exported": ["document_ref", "format"],
  "skill.alias_confirmed": [],
  "application.stage_changed": ["application_ref", "from", "to"],
  "application.passed": ["application_ref", "from"],
  "application.removed": ["application_ref", "from"],
  "application.restored": ["application_ref", "was", "to"],
  "application.goal_changed": ["application_ref"],
  "calibration.changed": ["active", "rules_version"],
  "email.connected": ["provider", "how"],
  "email.disconnected": [],
  "email.suggestion_accepted": ["application_ref", "kind"],
  "email.suggestion_dismissed": ["kind"],
  "extension.paired": [],
  "extension.revoked": [],
  "packet.built": ["application_ref", "packet_version", "fields", "left_for_applicant", "kept_from_approved", "differed_from_saved"],
  "packet.filled": ["application_ref", "packet_version", "filled", "left_for_applicant"],
  "packet.ready": ["application_ref", "packet_version", "ats"],
  "packet.submit_started": ["application_ref", "packet_version", "ats", "by"],
  "packet.outcome_unknown": ["application_ref", "packet_version"],
  // "by": "standing_setting" when the applicant's own Settings choice approved it (hands-free, Yong 2026-11-15), with that "mode".
  "packet.approved": ["application_ref", "packet_version", "packet_hash", "by", "mode"],
  "packet.submit_approved": ["application_ref", "packet_version", "submit_hash", "by", "mode"],
  "packet.submitted": [
    "application_ref", "employer", "job_ref", "resume_ref", "resume_version",
    "cover_letter_ref", "cover_letter_version", "answer_sources", "confirmation_ref",
  ],
  "packet.outcome_resolved": ["application_ref", "applicant_says"],
  "site_account.created": ["site_host", "site", "by"],
  "apply.mode_set": ["mode"],
  "apply.standing_set": ["kind", "on"],
  "apply.requested": ["application_ref"],
  // "Your turn" (Yong, 2026-11-17): every handover is logged like a submission. Never what was typed.
  "handover.paused": ["application_ref", "step", "phase", "expires_at"],
  "handover.opened": ["application_ref", "step"],
  "handover.handed_back": ["application_ref", "step", "by"],
  "handover.reminded": ["application_ref", "step"],
  "handover.closed": ["application_ref", "step", "phase", "outcome", "minutes"],
  "handover.finish_yourself": ["application_ref"],
  "profile.imported": ["kind", "parser", "rows"],
  "profile.filled_from_resume": ["fields"],
  "profile.about_saved": ["chars"],
  "profile.answer_kept": ["field", "where"],
  "resume.stored": ["kind", "file_kind", "bytes"],
  "resume.digested": ["run", "parser", "added", "same", "similar"],
  "resume.deleted": [],
  "passkey.added": ["label"],
  "passkey.removed": [],
  "data.exported": ["format"],
  "data.deleted": [],
  "source.followed": ["kind"],
  "source.unfollowed": ["kind"],
  "source.restored": ["kind"],
  "source.industry": ["industry"],
  "source.replaced": ["from", "to"],
  "sources.discovered": ["checked", "found", "followed", "unfollowed"],
  "settings.changed": ["setting", "removed"],
  "scan.finished": ["sources", "checked", "new_jobs", "updated", "closed"],
  "match.feedback": ["job_ref", "action", "reason"],
  "adjustment.changed": ["kind", "active"],
  // Invitations and admin actions (brief 2026-11-25 section 8). Only which account or invitation
  // (by id): never a code, a hash or a password, and no email (the brief allowed one, but the log's
  // standing rule keeps personal details out; the id leads to the email for anyone allowed to see it).
  "invite.created": ["invitation_ref"],
  "invite.revoked": ["invitation_ref", "reason"],
  "invite.accepted": ["invitation_ref"],
  "admin.access_off": ["account_ref"],
  "admin.access_on": ["account_ref"],
  "admin.password_reset_made": ["account_ref"],
  "admin.password_reset_done": ["account_ref"],
  "admin.two_step_reset": ["account_ref"],
  "admin.role_changed": ["account_ref", "is_admin"],
} as const satisfies Record<string, readonly string[]>;

export type AuditAction = keyof typeof AUDIT_ALLOWED_KEYS;

export function auditPayload(action: AuditAction, payload: Record<string, unknown>): Record<string, unknown> {
  const allowed: readonly string[] = AUDIT_ALLOWED_KEYS[action];
  const extra = Object.keys(payload).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`audit payload key not allowed for ${action}: ${extra.join(", ")}`);
  return payload;
}
