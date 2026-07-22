const { redisClient } = require('../config/redis');
const SecurityAlert = require('../models/SecurityAlert');
const logger = require('../utils/logger');

const WINDOW_MS = 60 * 1000; // 1 minute sliding window
const THRESHOLD = 5; // MORE than 5 failures within the window trips the alert
const ALERT_COOLDOWN_SECONDS = 60; // one alert per breach episode, not one per failure

function windowKey(ip) {
  return `login-fail-window:${ip}`;
}
function alertedKey(ip) {
  return `login-fail-alerted:${ip}`;
}

/**
 * Records a failed login from `ip` in a Redis sorted set keyed by event
 * timestamp (score), evicts anything outside the trailing window, and — if
 * the count still inside the window exceeds the threshold — writes a
 * SecurityAlert for librarian review.
 *
 * A true sliding window (sorted set + ZREMRANGEBYSCORE), not a fixed
 * bucket: a fixed window (e.g. "failures this calendar minute") can be
 * gamed by bursting just before and just after a bucket boundary, counting
 * as two separate under-threshold windows instead of one clearly-over-
 * threshold minute. This is a distinct, lighter-weight, faster-firing
 * signal purely for VISIBILITY — separate from Phase 6's IP block, which
 * enforces at a higher threshold (20 failures/10min) and is the actual
 * blocking control. This one's job is only to get a human's attention.
 *
 * The short-lived "already alerted" flag stops a sustained attack from
 * generating a fresh SecurityAlert on every single subsequent failure —
 * at most one alert per cooldown period per IP.
 */
async function recordFailedLogin(ip) {
  if (!ip) return;

  const now = Date.now();
  const key = windowKey(ip);

  await redisClient.zRemRangeByScore(key, 0, now - WINDOW_MS);
  await redisClient.zAdd(key, { score: now, value: `${now}-${Math.random().toString(36).slice(2)}` });
  await redisClient.expire(key, Math.ceil(WINDOW_MS / 1000));

  const count = await redisClient.zCard(key);

  if (count <= THRESHOLD) {
    return;
  }

  const alreadyAlerted = await redisClient.get(alertedKey(ip));
  if (alreadyAlerted) {
    return;
  }

  await redisClient.set(alertedKey(ip), '1', { EX: ALERT_COOLDOWN_SECONDS });

  try {
    await SecurityAlert.create({
      type: 'excessive_failed_logins',
      ip,
      details: `${count} failed login attempts from this IP within the last ${WINDOW_MS / 1000}s`,
    });
  } catch (err) {
    // A monitoring failure must never break the login request it's
    // attached to.
    logger.error(`Failed to write security alert: ${err.message}`);
  }
}

module.exports = { recordFailedLogin };
