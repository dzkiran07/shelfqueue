const { rateLimit } = require('express-rate-limit');
const { RedisStore } = require('rate-limit-redis');
const { redisClient } = require('../config/redis');

function redisStore(prefix) {
  return new RedisStore({
    sendCommand: (...args) => redisClient.sendCommand(args),
    prefix,
  });
}

const RATE_LIMIT_MESSAGE = { error: 'Too many requests. Please try again shortly.' };

// Applied to authentication and other sensitive endpoints — login and
// register today, and (per later phases) MFA verification, password reset,
// and WebAuthn challenge as they're built — so brute-force/credential-
// stuffing attempts hit the same tight ceiling everywhere it matters,
// rather than only on whichever two endpoints happened to exist first.
const strictAuthLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore('rl:strict:'),
  message: RATE_LIMIT_MESSAGE,
});

// Looser ceiling applied globally, mainly to blunt scripted abuse without
// getting in the way of normal browsing/catalog use.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  store: redisStore('rl:global:'),
  message: RATE_LIMIT_MESSAGE,
});

module.exports = { strictAuthLimiter, globalLimiter };
