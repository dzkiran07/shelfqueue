const AuditLog = require('../models/AuditLog');
const logger = require('../utils/logger');

/**
 * NEVER pass any of the following into an audit log entry, in `metadata` or
 * anywhere else:
 *   - passwordHash / passwordHistory — even hashed, credentials have no
 *     place in an operational audit trail.
 *   - mfaSecretEncrypted, or any raw TOTP secret / OTP / verification code
 *     — logging a code would defeat the point of it being time-limited and
 *     single-use, and the encrypted secret is still a secret.
 *   - Raw JWTs or session identifiers (access/refresh/mfa_pending/
 *     oauth_link tokens, CSRF tokens) — possession of a logged token is as
 *     good as possession of the real one.
 * An AuditLog entry should describe WHAT happened, to WHICH resource, and
 * WHO/WHAT triggered it — never the secrets involved in how it happened.
 * `logActivity` doesn't (and can't) enforce this by itself; every call site
 * below is responsible for only ever passing identifiers and non-sensitive
 * context into `metadata`.
 */
async function logActivity({ actorId, action, resourceType, resourceId, req, ip, userAgent, metadata }) {
  try {
    await AuditLog.create({
      actorId: actorId ?? undefined,
      action,
      resourceType,
      resourceId: resourceId ?? undefined,
      ip: ip ?? req?.ip,
      userAgent: userAgent ?? req?.headers?.['user-agent'],
      metadata,
    });
  } catch (err) {
    // Audit logging must never break the operation it's attached to — a
    // successful login/loan/etc. shouldn't fail the user's request just
    // because the audit write itself hiccupped. Log server-side and move on.
    logger.error(`Failed to write audit log entry (${action}): ${err.message}`);
  }
}

module.exports = { logActivity };
