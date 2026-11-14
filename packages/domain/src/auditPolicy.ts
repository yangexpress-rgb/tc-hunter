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
  "mfa.disabled": [],
  "document.approved": ["document_ref", "type", "version", "content_hash"],
  "document.generated": ["document_ref", "type", "version", "proposer", "blocked"],
  "document.exported": ["document_ref", "format"],
  "skill.alias_confirmed": [],
  "application.stage_changed": ["application_ref", "from", "to"],
  "calibration.changed": ["active", "rules_version"],
  "email.connected": ["provider"],
  "email.disconnected": [],
  "email.suggestion_accepted": ["application_ref", "kind"],
  "email.suggestion_dismissed": ["kind"],
  "extension.paired": [],
  "extension.revoked": [],
  "packet.built": ["application_ref", "packet_version", "fields", "left_for_applicant"],
  "packet.filled": ["application_ref", "packet_version", "filled", "left_for_applicant"],
  "packet.approved": ["application_ref", "packet_version", "packet_hash"],
  "packet.submit_approved": ["application_ref", "packet_version", "submit_hash"],
  "packet.submitted": [
    "application_ref", "employer", "job_ref", "resume_ref", "resume_version",
    "cover_letter_ref", "cover_letter_version", "answer_sources", "confirmation_ref",
  ],
  "packet.outcome_resolved": ["application_ref", "applicant_says"],
  "site_account.created": ["site_host"],
  "profile.imported": ["kind", "parser", "rows"],
  "passkey.added": ["label"],
  "passkey.removed": [],
  "data.exported": ["format"],
  "data.deleted": [],
  "source.followed": ["kind"],
  "source.unfollowed": ["kind"],
  "scan.finished": ["sources", "checked", "new_jobs", "updated", "closed"],
  "match.feedback": ["job_ref", "action", "reason"],
  "adjustment.changed": ["kind", "active"],
} as const satisfies Record<string, readonly string[]>;

export type AuditAction = keyof typeof AUDIT_ALLOWED_KEYS;

export function auditPayload(action: AuditAction, payload: Record<string, unknown>): Record<string, unknown> {
  const allowed: readonly string[] = AUDIT_ALLOWED_KEYS[action];
  const extra = Object.keys(payload).filter((k) => !allowed.includes(k));
  if (extra.length) throw new Error(`audit payload key not allowed for ${action}: ${extra.join(", ")}`);
  return payload;
}
