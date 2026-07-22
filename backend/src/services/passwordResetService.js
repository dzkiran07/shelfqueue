const crypto = require('crypto');
const { redisClient } = require('../config/redis');

const RESET_TOKEN_TTL_SECONDS = 15 * 60; // fixed 15 minutes, per spec

function resetTokenKey(hashedToken) {
  return `password-reset:${hashedToken}`;
}
function userTokenKey(userId) {
  return `password-reset-user:${userId}`;
}

function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

/**
 * Generates a single-use, 15-minute password reset token. Only the SHA-256
 * hash of the token is ever stored (in Redis) — the raw token exists only
 * in this function's return value, to be emailed to the user and never
 * persisted anywhere in that form, mirroring how refresh tokens/CSRF
 * tokens are handled elsewhere in this app: possession of the raw value
 * is the credential, so the stored side never holds anything an attacker
 * could use directly even with full datastore read access.
 *
 * Any previously-issued, still-outstanding token for this user is
 * invalidated first — only the most recently requested reset link should
 * ever work, not every link a user has ever been emailed.
 */
async function createResetToken(userId) {
  const previousHashedToken = await redisClient.get(userTokenKey(userId));
  if (previousHashedToken) {
    await redisClient.del(resetTokenKey(previousHashedToken));
  }

  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashedToken = hashToken(rawToken);

  await redisClient.set(resetTokenKey(hashedToken), String(userId), {
    EX: RESET_TOKEN_TTL_SECONDS,
  });
  await redisClient.set(userTokenKey(userId), hashedToken, { EX: RESET_TOKEN_TTL_SECONDS });

  return rawToken;
}

/**
 * Validates and immediately consumes a reset token — the token is deleted
 * from Redis as soon as it's looked up, regardless of what the caller does
 * next, so a single raw token value can never be used twice even if the
 * subsequent password-policy validation fails and the client retries with
 * the same (now-dead) link.
 *
 * @returns {Promise<string|null>} the associated userId, or null if the
 *   token is missing/expired/already used.
 */
async function consumeResetToken(rawToken) {
  const hashedToken = hashToken(String(rawToken));
  const userId = await redisClient.get(resetTokenKey(hashedToken));
  if (!userId) {
    return null;
  }

  await redisClient.del(resetTokenKey(hashedToken));
  await redisClient.del(userTokenKey(userId));

  return userId;
}

module.exports = { createResetToken, consumeResetToken };
