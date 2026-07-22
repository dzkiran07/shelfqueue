const { createClient } = require('redis');
const env = require('./env');
const logger = require('../utils/logger');

const redisClient = createClient({ url: env.REDIS_URL });

redisClient.on('error', (err) => {
  logger.error(`Redis error: ${err.message}`);
});
redisClient.on('connect', () => {
  logger.info('Redis connected');
});
redisClient.on('reconnecting', () => {
  logger.warn('Redis reconnecting');
});

async function connectRedis() {
  if (!redisClient.isOpen) {
    await redisClient.connect();
  }
  return redisClient;
}

module.exports = { redisClient, connectRedis };
