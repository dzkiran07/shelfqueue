const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const passport = require('./services/oauthService');
const env = require('./config/env');
const errorHandler = require('./middleware/errorHandler');
const { globalLimiter } = require('./middleware/rateLimit');
const { sanitizeInput } = require('./middleware/sanitize');
const { csrfProtection, issueCsrfToken } = require('./middleware/csrf');
const authRoutes = require('./routes/auth.routes');
const loanRoutes = require('./routes/loan.routes');
const userRoutes = require('./routes/user.routes');
const adminRoutes = require('./routes/admin.routes');
const bookRoutes = require('./routes/book.routes');
const waitlistRoutes = require('./routes/waitlist.routes');

const app = express();

// Strict CSP: no 'unsafe-inline' for scripts — the frontend is a separate
// origin SPA, this API never serves script-bearing HTML itself, so the
// default-src can stay locked down to 'self'.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
      },
    },
  })
);

app.use(
  cors({
    origin: env.FRONTEND_ORIGIN,
    credentials: true, // auth cookies are cross-origin (frontend on :5173, API on :5000)
  })
);

app.use(globalLimiter);
app.use(express.json({ limit: '100kb' }));
app.use(cookieParser());
// Sanitize req.body/query/params BEFORE any route is mounted. Registering
// this after a route's already been mounted would leave that route's
// input completely unsanitized — Express middleware only applies to
// requests handled after it's registered, not retroactively — so this
// specific position (post body-parsing, pre every route) matters, not
// just its presence somewhere in the file.
app.use(sanitizeInput);
// No passport.session() — this app never uses passport sessions, only its
// own JWT-cookie session system (tokenService).
app.use(passport.initialize());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

app.get('/api/csrf-token', issueCsrfToken);

// CSRF protection is deliberately NOT applied to /api/auth: login/register
// have no session yet to bind a token to, and gating /refresh behind a
// CSRF token would create a deadlock (refresh is precisely what a client
// calls when its access token — and the ability to have fetched a fresh
// CSRF token via a requireAuth-style check — has expired). Those endpoints
// are already defended by CAPTCHA, rate limiting, account lockout, and
// refresh-token rotation/reuse-detection, which is a stronger fit for that
// specific threat model than a CSRF token would be. It's applied here, to
// authenticated resource-mutation routes, which is what this phase's own
// test scenarios (and OWASP's CSRF guidance) are actually about.
app.use('/api/auth', authRoutes);
app.use('/api/loans', csrfProtection, loanRoutes);
app.use('/api/users', csrfProtection, userRoutes);
app.use('/api/admin', csrfProtection, adminRoutes);
app.use('/api/books', csrfProtection, bookRoutes);
app.use('/api/waitlist', csrfProtection, waitlistRoutes);

// 404 for anything unmatched, before the error handler.
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Must be registered last — Express identifies error middleware by arity.
app.use(errorHandler);

module.exports = app;
