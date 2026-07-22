const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { redisClient } = require('../config/redis');

const ACCESS_TOKEN_EXPIRY = '15d';
const REFRESH_TOKEN_EXPIRY = '30d';
const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
const ACCESS_TOKEN_MAX_AGE_MS = 15 * 24 * 60 * 60 * 1000;
const REFRESH_TOKEN_MAX_AGE_MS = REFRESH_TOKEN_TTL_SECONDS * 1000;

// Proves "this request already supplied the correct password" for a user
// with MFA enabled, without granting a session — the only thing it can be
// exchanged for is a completed MFA challenge, and only within 5 minutes.
const MFA_PENDING_TOKEN_EXPIRY = '5m';

// Carries "which logged-in user asked to link a Google account" through the
// OAuth redirect round-trip via the `state` param. Our own access-token
// cookie is SameSite=Strict, so it is NOT sent on the top-level navigation
// back from accounts.google.com — that's a cross-site redirect, not a
// same-site one — so cookies alone can't identify the linking user here.
// This signed, short-lived token substitutes for that, and doubles as
// passport's anti-CSRF state check since it can't be forged without
// JWT_SECRET.
const OAUTH_LINK_TOKEN_EXPIRY = '5m';

const ACCESS_TOKEN_COOKIE = 'accessToken';
const REFRESH_TOKEN_COOKIE = 'refreshToken';

function sessionKey(userId, familyId) {
  return `session:${userId}:${familyId}`;
}

// Tracks which session families belong to a user so they can be listed
// (GET /api/auth/sessions) without an expensive/discouraged Redis KEYS or
// SCAN over the whole keyspace.
function userSessionsSetKey(userId) {
  return `user-sessions:${userId}`;
}

/**
 * Fingerprint used for optional device binding (Phase 12): hashes the
 * User-Agent header together with a stable, client-generated device id
 * (sent as X-Device-Id). Only ever compared against itself — never
 * reversed — so a plain SHA-256 digest is sufficient here.
 */
function computeDeviceFingerprint(req) {
  const userAgent = req.headers['user-agent'] || '';
  const deviceId = req.headers['x-device-id'] || '';
  return crypto.createHash('sha256').update(`${userAgent}:${deviceId}`).digest('hex');
}

function signAccessToken(userId) {
  // Deliberately minimal payload — no role/status embedded. Zero-trust
  // authorization (Phase 10) re-fetches the user's current role/status from
  // MongoDB on every protected request rather than trusting the JWT body,
  // so a role change or suspension takes effect immediately instead of
  // waiting up to 15 days for the token to expire.
  return jwt.sign({ sub: String(userId), type: 'access' }, env.JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY,
  });
}

function signRefreshToken({ userId, familyId, jti }) {
  return jwt.sign(
    { sub: String(userId), familyId, jti, type: 'refresh' },
    env.JWT_REFRESH_SECRET,
    { expiresIn: REFRESH_TOKEN_EXPIRY }
  );
}

function verifyAccessToken(token) {
  return jwt.verify(token, env.JWT_SECRET);
}

function verifyRefreshToken(token) {
  return jwt.verify(token, env.JWT_REFRESH_SECRET);
}

// Delivered in the response body, never as a cookie — unlike access/refresh
// tokens this isn't a session credential, just a short-lived, single-
// purpose proof that lets the client complete the very next MFA challenge.
function signMfaPendingToken(userId) {
  return jwt.sign({ sub: String(userId), type: 'mfa_pending' }, env.JWT_SECRET, {
    expiresIn: MFA_PENDING_TOKEN_EXPIRY,
  });
}

function verifyMfaPendingToken(token) {
  const payload = jwt.verify(token, env.JWT_SECRET);
  if (payload.type !== 'mfa_pending') {
    throw new Error('Not an MFA pending token');
  }
  return payload;
}

function signOauthLinkToken(userId) {
  return jwt.sign({ sub: String(userId), type: 'oauth_link' }, env.JWT_SECRET, {
    expiresIn: OAUTH_LINK_TOKEN_EXPIRY,
  });
}

function verifyOauthLinkToken(token) {
  const payload = jwt.verify(token, env.JWT_SECRET);
  if (payload.type !== 'oauth_link') {
    throw new Error('Not an OAuth link token');
  }
  return payload;
}

/**
 * WHY A REDIS-BACKED SESSION RECORD EXISTS AT ALL:
 * The access token is deliberately long-lived (15 days) so users aren't
 * forced to silently re-authenticate every few minutes. But a JWT can't be
 * "un-signed" once issued — expiry is the *only* thing that ends its
 * validity unless something else checks in. Relying on expiry alone would
 * mean a stolen/leaked access token stays usable for up to 15 days no
 * matter what the server does in response.
 *
 * The refresh token is the compensating control: it's checked against a
 * Redis-stored record on every use, so a session can be revoked
 * server-side (logout, detected token reuse, an account being suspended)
 * long before either token's own signed expiry would end it. The access
 * token's blast radius in the meantime is accepted as a deliberate
 * trade-off for not re-verifying against Redis on every single request.
 */
// Every call mints a brand-new familyId — there is no code path that
// carries a pre-existing session/family across the unauthenticated ->
// authenticated boundary, so login (and MFA challenge, and OAuth callback)
// always regenerates the session from scratch. That's the anti-fixation
// property this phase asks for: nothing an attacker set before login can
// still be the session id after login.
async function issueSession(userId, { fingerprint, userAgent } = {}) {
  const familyId = crypto.randomUUID();
  const jti = crypto.randomUUID();
  const now = Date.now();

  const record = { jti, createdAt: now, lastUsedAt: now };
  if (fingerprint) record.fingerprint = fingerprint;
  if (userAgent) record.userAgent = userAgent;

  await redisClient.set(sessionKey(userId, familyId), JSON.stringify(record), {
    EX: REFRESH_TOKEN_TTL_SECONDS,
  });
  await redisClient.sAdd(userSessionsSetKey(userId), familyId);
  // Keep the index's own TTL refreshed so it can't outlive every session it
  // points to.
  await redisClient.expire(userSessionsSetKey(userId), REFRESH_TOKEN_TTL_SECONDS);

  return {
    accessToken: signAccessToken(userId),
    refreshToken: signRefreshToken({ userId, familyId, jti }),
  };
}

/**
 * Validates a presented refresh token against its Redis session record and
 * rotates it: the old refresh token is single-use — presenting it again
 * after rotation is treated as reuse (a strong signal of a stolen token)
 * and revokes the entire session family rather than just rejecting the one
 * request, since we can no longer tell the legitimate client apart from an
 * attacker holding a copy of the same token.
 *
 * @returns {Promise<{status: 'ok', userId: string, familyId: string, tokens: {accessToken: string, refreshToken: string}}
 *                  | {status: 'invalid' | 'reused' | 'device_mismatch'}>}
 */
async function rotateRefreshToken(refreshToken, { fingerprint } = {}) {
  let payload;
  try {
    payload = verifyRefreshToken(refreshToken);
  } catch (err) {
    return { status: 'invalid' };
  }

  const { sub: userId, familyId, jti } = payload;
  if (!familyId || !jti) {
    return { status: 'invalid' };
  }

  const key = sessionKey(userId, familyId);
  const raw = await redisClient.get(key);
  if (!raw) {
    // Session already expired/logged-out/revoked — nothing to rotate.
    return { status: 'invalid' };
  }

  const record = JSON.parse(raw);
  if (record.jti !== jti) {
    // Not the most recently issued token for this family. Burn the whole
    // family rather than guessing whether this request or the last
    // successful one was the legitimate client.
    await redisClient.del(key);
    await redisClient.sRem(userSessionsSetKey(userId), familyId);
    return { status: 'reused' };
  }

  // Optional device binding (config-gated — see env.DEVICE_BINDING_ENABLED):
  // if this session was issued with a fingerprint and the caller supplies
  // one that doesn't match, treat it the same as reuse — the refresh token
  // is being presented from somewhere other than the device it was issued
  // to, which is exactly the scenario this control exists to catch.
  if (env.DEVICE_BINDING_ENABLED && record.fingerprint && fingerprint && record.fingerprint !== fingerprint) {
    await redisClient.del(key);
    await redisClient.sRem(userSessionsSetKey(userId), familyId);
    return { status: 'device_mismatch' };
  }

  const newJti = crypto.randomUUID();
  const updatedRecord = { ...record, jti: newJti, lastUsedAt: Date.now() };
  await redisClient.set(key, JSON.stringify(updatedRecord), {
    EX: REFRESH_TOKEN_TTL_SECONDS,
  });

  return {
    status: 'ok',
    userId,
    familyId,
    tokens: {
      accessToken: signAccessToken(userId),
      refreshToken: signRefreshToken({ userId, familyId, jti: newJti }),
    },
  };
}

async function revokeSession(userId, familyId) {
  if (!userId || !familyId) return;
  await redisClient.del(sessionKey(userId, familyId));
  await redisClient.sRem(userSessionsSetKey(userId), familyId);
}

/**
 * Revokes every active session for a user — used on password reset
 * (Phase 24) so a stolen session, if any, stops working the instant the
 * account owner proves control of their email and resets the password,
 * rather than lingering until each token's own natural expiry.
 */
async function revokeAllSessions(userId) {
  const sessions = await listSessions(userId);
  for (const session of sessions) {
    // eslint-disable-next-line no-await-in-loop
    await revokeSession(userId, session.id);
  }
}

/**
 * Lists a user's active sessions for the "manage active sessions" account
 * feature. Reads the per-user family-id index rather than scanning the
 * keyspace, and opportunistically prunes any family id whose session
 * already expired out of Redis naturally (TTL) but is still listed in the
 * index.
 */
async function listSessions(userId) {
  const familyIds = await redisClient.sMembers(userSessionsSetKey(userId));
  const sessions = [];

  for (const familyId of familyIds) {
    // eslint-disable-next-line no-await-in-loop
    const raw = await redisClient.get(sessionKey(userId, familyId));
    if (!raw) {
      // eslint-disable-next-line no-await-in-loop
      await redisClient.sRem(userSessionsSetKey(userId), familyId);
      continue;
    }

    const record = JSON.parse(raw);
    sessions.push({
      id: familyId,
      createdAt: record.createdAt,
      lastUsedAt: record.lastUsedAt || record.createdAt,
      userAgent: record.userAgent || null,
    });
  }

  return sessions;
}

function baseCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'strict',
    // Secure cookies are only ever sent over an actual TLS connection, so
    // this must track whether *this* process is really serving HTTPS
    // (env.HTTPS_ENABLED — mkcert certs mounted for local dev/pentest) —
    // not just NODE_ENV, since plain `production` alone would send Secure
    // cookies from a dev server that never gained TLS, silently dropping
    // them at the browser instead of setting them.
    secure: env.NODE_ENV === 'production' || env.HTTPS_ENABLED,
    path: '/',
  };
}

function setAuthCookies(res, { accessToken, refreshToken }) {
  res.cookie(ACCESS_TOKEN_COOKIE, accessToken, {
    ...baseCookieOptions(),
    maxAge: ACCESS_TOKEN_MAX_AGE_MS,
  });
  res.cookie(REFRESH_TOKEN_COOKIE, refreshToken, {
    ...baseCookieOptions(),
    maxAge: REFRESH_TOKEN_MAX_AGE_MS,
  });
}

function clearAuthCookies(res) {
  res.clearCookie(ACCESS_TOKEN_COOKIE, baseCookieOptions());
  res.clearCookie(REFRESH_TOKEN_COOKIE, baseCookieOptions());
}

module.exports = {
  ACCESS_TOKEN_COOKIE,
  REFRESH_TOKEN_COOKIE,
  signAccessToken,
  verifyAccessToken,
  verifyRefreshToken,
  signMfaPendingToken,
  verifyMfaPendingToken,
  signOauthLinkToken,
  verifyOauthLinkToken,
  computeDeviceFingerprint,
  issueSession,
  rotateRefreshToken,
  revokeSession,
  revokeAllSessions,
  listSessions,
  setAuthCookies,
  clearAuthCookies,
};
