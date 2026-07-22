const crypto = require('crypto');
const env = require('../config/env');
const tokenService = require('../services/tokenService');

const STATE_CHANGING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * The "session id" a CSRF token is bound to is the refresh token's
 * familyId — the same server-side session identifier tokenService already
 * uses for rotation/revocation — not the access token. That's deliberate:
 * deriving it from the access token would mean an expired access token
 * (exactly the moment a client needs to call /api/auth/refresh) also blocks
 * fetching a fresh CSRF token, a deadlock. The refresh cookie is the
 * longer-lived, more reliable "is there a session here at all" signal.
 * Returns null if there's no session (missing/invalid/expired refresh
 * cookie) — callers treat that as "nothing to bind a token to."
 */
function getSessionId(req) {
  const refreshToken = req.cookies?.[tokenService.REFRESH_TOKEN_COOKIE];
  if (!refreshToken) {
    return null;
  }
  try {
    const payload = tokenService.verifyRefreshToken(refreshToken);
    return payload.familyId || null;
  } catch (err) {
    return null;
  }
}

function generateCsrfToken(sessionId) {
  return crypto.createHmac('sha256', env.CSRF_SECRET).update(sessionId).digest('hex');
}

/**
 * GET /api/csrf-token — mints a token bound to the caller's current
 * session. Requires a valid session (refresh cookie) to exist; there's
 * nothing meaningful to bind a token to otherwise.
 */
function issueCsrfToken(req, res) {
  const sessionId = getSessionId(req);
  if (!sessionId) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  return res.status(200).json({ csrfToken: generateCsrfToken(sessionId) });
}

/**
 * Rejects state-changing requests (POST/PUT/PATCH/DELETE) unless the
 * X-CSRF-Token header matches the HMAC expected for the requester's own
 * session. Not a plain cookie-vs-header double-submit — an attacker who
 * can plant their own cookie on the victim's browser (e.g. via a
 * subdomain, or before the app sets one) could satisfy a naive "header
 * equals a second cookie" check trivially. Binding the token to the
 * server-side session via HMAC means forging a valid token requires
 * knowing CSRF_SECRET, not just being able to set a cookie.
 *
 * GET/HEAD/OPTIONS are never checked (nothing state-changing to protect),
 * which is also why the OAuth callback route needs no special-casing here
 * — it's a GET request and is already outside this middleware's scope.
 * Requests with no session at all (no valid refresh cookie — e.g. login,
 * register) pass through untouched: there's no session to protect yet,
 * and any route that does require auth will already reject an
 * unauthenticated caller upstream of this check.
 */
function csrfProtection(req, res, next) {
  if (!STATE_CHANGING_METHODS.includes(req.method)) {
    return next();
  }

  const sessionId = getSessionId(req);
  if (!sessionId) {
    return next();
  }

  const submitted = req.headers['x-csrf-token'];
  if (!submitted || typeof submitted !== 'string') {
    return res.status(403).json({ error: 'Missing CSRF token' });
  }

  const expected = generateCsrfToken(sessionId);
  const expectedBuf = Buffer.from(expected, 'hex');
  const submittedBuf = Buffer.from(submitted, 'hex');

  const isValid =
    expectedBuf.length === submittedBuf.length && crypto.timingSafeEqual(expectedBuf, submittedBuf);

  if (!isValid) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }

  return next();
}

module.exports = { csrfProtection, issueCsrfToken, generateCsrfToken, getSessionId };
