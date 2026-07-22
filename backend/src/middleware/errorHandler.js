const env = require('../config/env');
const logger = require('../utils/logger');

// Centralized error handler — must be registered last, after all routes.
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  const status = err.statusCode || err.status || 500;

  logger.error(err.stack || err.message);

  const body = {
    error: status === 500 ? 'Internal server error' : err.message,
  };

  // Stack traces are dev-only diagnostic info — leaking them in production
  // responses would hand an attacker internal file paths and library
  // versions for free.
  if (env.NODE_ENV !== 'production') {
    body.stack = err.stack;
  }

  res.status(status).json(body);
}

module.exports = errorHandler;
