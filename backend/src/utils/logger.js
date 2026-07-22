const path = require('path');
const winston = require('winston');
const env = require('../config/env');

const { combine, timestamp, errors, printf, colorize, json } = winston.format;

const consoleFormat = combine(
  colorize(),
  timestamp(),
  errors({ stack: true }),
  printf(({ level, message, timestamp: ts, stack }) => `${ts} [${level}] ${stack || message}`)
);

const fileFormat = combine(timestamp(), errors({ stack: true }), json());

const logsDir = path.join(__dirname, '..', '..', 'logs');

const logger = winston.createLogger({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  transports: [
    new winston.transports.Console({ format: consoleFormat }),
    new winston.transports.File({
      filename: path.join(logsDir, 'error.log'),
      level: 'error',
      format: fileFormat,
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'combined.log'),
      format: fileFormat,
    }),
  ],
  // Don't crash the process on a logging transport failure.
  exitOnError: false,
});

module.exports = logger;
