require('dotenv').config();

// Fail fast on missing config rather than limping along with `undefined`
// secrets that would silently break auth/crypto later.
const REQUIRED_IN_PRODUCTION = [
  'DB_URI',
  'REDIS_URL',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'MFA_ENCRYPTION_KEY',
  'CSRF_SECRET',
];

const env = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT, 10) || 5000,
  FRONTEND_ORIGIN: process.env.FRONTEND_ORIGIN || 'http://localhost:5173',
  // This API's own origin — needed to build an absolute OAuth callback URL.
  BACKEND_ORIGIN: process.env.BACKEND_ORIGIN || 'http://localhost:5000',

  DB_URI: process.env.DB_URI || 'mongodb://localhost:27017/shelfqueue',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  JWT_SECRET: process.env.JWT_SECRET,
  JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,

  // Separate from the JWT secrets on purpose — a leaked CSRF secret and a
  // leaked JWT secret are different-severity incidents, so they shouldn't
  // be the same value.
  CSRF_SECRET: process.env.CSRF_SECRET,

  // Fallback lets the app boot locally without real Google credentials —
  // the OAuth strategy still constructs fine, actual sign-in just fails
  // until real values are supplied.
  GOOGLE_OAUTH_CLIENT_ID: process.env.GOOGLE_OAUTH_CLIENT_ID || 'not-configured',
  GOOGLE_OAUTH_CLIENT_SECRET: process.env.GOOGLE_OAUTH_CLIENT_SECRET || 'not-configured',

  MFA_ENCRYPTION_KEY: process.env.MFA_ENCRYPTION_KEY,
  CAPTCHA_SECRET: process.env.CAPTCHA_SECRET,

  ETHEREAL_EMAIL: process.env.ETHEREAL_EMAIL,
  ETHEREAL_PASSWORD: process.env.ETHEREAL_PASSWORD,

  // Real SMTP delivery (e.g. Gmail + an App Password). When SMTP_HOST is
  // set, emailService sends through this instead of the Ethereal sandbox —
  // lets password-reset links actually land in the recipient's real inbox.
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: parseInt(process.env.SMTP_PORT, 10) || 587,
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
  SMTP_FROM: process.env.SMTP_FROM || process.env.SMTP_USER,

  // Comma-separated IPs that bypass IP-based brute-force blocking (Phase 6)
  // — e.g. a trusted office/CI network. Does not bypass per-account lockout.
  ALLOWED_IPS: (process.env.ALLOWED_IPS || '')
    .split(',')
    .map((ip) => ip.trim())
    .filter(Boolean),

  // Off by default — device-fingerprint binding on refresh can be too
  // strict for some legitimate clients (UA-rewriting proxies, some mobile
  // browsers), so it's opt-in per deployment (Phase 12).
  DEVICE_BINDING_ENABLED: process.env.DEVICE_BINDING_ENABLED === 'true',

  // How long a waitlist offer stays claimable before it's swept and passed
  // to the next person in line (Phase 19). Configurable mainly so a demo/
  // PoC recording can override it to something short instead of waiting
  // out a real 48-hour window.
  WAITLIST_OFFER_HOURS: parseFloat(process.env.WAITLIST_OFFER_HOURS) || 48,
  WAITLIST_SWEEP_INTERVAL_MS: parseInt(process.env.WAITLIST_SWEEP_INTERVAL_MS, 10) || 5 * 60 * 1000,

  // Loan due date = approval time + this many days (Phase 20). Also drives
  // how the overdue sweep decides a checked-out loan is late.
  LOAN_PERIOD_DAYS: parseFloat(process.env.LOAN_PERIOD_DAYS) || 14,
  OVERDUE_SWEEP_INTERVAL_MS: parseInt(process.env.OVERDUE_SWEEP_INTERVAL_MS, 10) || 5 * 60 * 1000,

  // A password older than this forces a reset before the next normal login
  // succeeds (Phase 24). Configurable per the brief's "e.g. 90 days" framing.
  PASSWORD_EXPIRY_DAYS: parseFloat(process.env.PASSWORD_EXPIRY_DAYS) || 90,

  // WebAuthn (Phase 25). RP ID must be a bare domain (no scheme/port) that
  // matches the domain the browser sees in its address bar when calling
  // navigator.credentials — for local dev that's 'localhost', matching
  // FRONTEND_ORIGIN's host regardless of its port.
  WEBAUTHN_RP_ID: process.env.WEBAUTHN_RP_ID || 'localhost',
  WEBAUTHN_RP_NAME: process.env.WEBAUTHN_RP_NAME || 'ShelfQueue',
};

if (env.NODE_ENV === 'production') {
  const missing = REQUIRED_IN_PRODUCTION.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
}

module.exports = env;
