const fs = require('fs');
const http = require('http');
const https = require('https');
const env = require('./config/env');
const connectDB = require('./config/db');
const { connectRedis } = require('./config/redis');
const logger = require('./utils/logger');
const { sweepExpiredOffers } = require('./services/waitlistService');
const { sweepOverdueLoans } = require('./services/loanService');

// Local HTTPS via mkcert (see docs/https-local-dev.md): only enabled when
// both files actually exist on disk, so this degrades to plain HTTP
// automatically anywhere the certs/ volume isn't mounted — CI's ZAP job,
// `npm run dev` outside Docker, a fresh clone before mkcert has run, etc.
function loadTlsOptions() {
  if (!env.HTTPS_ENABLED) return null;
  return {
    cert: fs.readFileSync(env.SSL_CERT_PATH),
    key: fs.readFileSync(env.SSL_KEY_PATH),
  };
}

async function start() {
  await connectDB();
  await connectRedis();

  // Deferred until after connectRedis() resolves: requiring app.js pulls in
  // middleware/rateLimit.js, whose RedisStore constructor sends a command
  // to Redis immediately (to preload its increment script) rather than
  // waiting for first use — requiring it any earlier throws
  // ClientClosedError because the client's socket doesn't exist yet.
  const app = require('./app');

  const tlsOptions = loadTlsOptions();
  const server = tlsOptions ? https.createServer(tlsOptions, app) : http.createServer(app);

  server.listen(env.PORT, () => {
    const scheme = tlsOptions ? 'https' : 'http';
    logger.info(`ShelfQueue API listening on ${scheme}://0.0.0.0:${env.PORT} (${env.NODE_ENV})`);
  });

  // Coursework-scale scheduled job: a simple interval rather than a real
  // cron/queue system. Sweeps waitlist offers whose claim window has
  // passed and hands each one to the next person in line.
  setInterval(() => {
    sweepExpiredOffers().catch((err) => {
      logger.error(`Waitlist offer sweep failed: ${err.stack || err.message}`);
    });
  }, env.WAITLIST_SWEEP_INTERVAL_MS);

  // Flips checked-out loans past their dueDate to 'overdue'.
  setInterval(() => {
    sweepOverdueLoans().catch((err) => {
      logger.error(`Overdue loan sweep failed: ${err.stack || err.message}`);
    });
  }, env.OVERDUE_SWEEP_INTERVAL_MS);
}

start().catch((err) => {
  logger.error(`Failed to start server: ${err.stack || err.message}`);
  process.exit(1);
});
