/**
 * Seeds two known-credential accounts for manual pentesting (Phase 33+):
 * one 'member' and one 'librarian'. Writes directly to MongoDB via the
 * Mongoose model — never through the HTTP API — so it does not touch
 * requireCaptcha, strictAuthLimiter, or account lockout at all. That's a
 * deliberate bypass scoped to this script only; it doesn't change how the
 * running app enforces those controls for anyone else.
 *
 * Idempotent: safe to re-run. Each run upserts both accounts back to a
 * known-good state (active, not locked out, password not expired), which
 * doubles as a quick "unlock" if a pentest session trips the account
 * lockout or you want a clean slate between test passes.
 *
 * Usage (from the backend container, so DB_URI already points at the
 * compose network's `mongo` service):
 *   docker compose exec backend node scripts/seed-test-users.js
 */
const connectDB = require('../src/config/db');
const env = require('../src/config/env');
const User = require('../src/models/User');
const { hashPassword } = require('../src/services/passwordPolicy');

if (env.NODE_ENV === 'production') {
  console.error('Refusing to seed known test credentials with NODE_ENV=production.');
  process.exit(1);
}

const TEST_USERS = [
  {
    name: 'ShelfQueue QA Member',
    email: 'member.test@shelfqueue.local',
    password: 'P3ntest!Member2026',
    role: 'member',
  },
  {
    name: 'ShelfQueue QA Librarian',
    email: 'librarian.test@shelfqueue.local',
    password: 'P3ntest!Librarian2026',
    role: 'librarian',
  },
];

async function seedUser({ name, email, password, role }) {
  const passwordHash = await hashPassword(password);

  await User.findOneAndUpdate(
    { email },
    {
      $set: {
        name,
        email,
        passwordHash,
        role,
        status: 'active',
        mfaEnabled: false,
        failedLoginAttempts: 0,
        lockoutUntil: null,
        lockoutCount: 0,
        passwordChangedAt: new Date(),
      },
      $setOnInsert: {
        passwordHistory: [],
        oauthProviders: [],
        webauthnCredentials: [],
      },
    },
    { upsert: true, new: true }
  );
}

async function main() {
  await connectDB();

  for (const user of TEST_USERS) {
    // eslint-disable-next-line no-await-in-loop
    await seedUser(user);
  }

  console.log('\n=== ShelfQueue test accounts seeded ===\n');
  console.table(
    TEST_USERS.map(({ name, email, password, role }) => ({ role, name, email, password }))
  );

  console.log(`
=== Point a browser at the app through Burp's proxy ===

1. Start (or confirm) the stack is running:
     docker compose up -d
   (or, for a dedicated test profile with NODE_ENV=test on the backend:
     docker compose -f docker-compose.yml -f docker-compose.test.yml up -d --build)

2. In Burp Suite Professional: Proxy > Proxy settings > confirm a proxy
   listener exists on 127.0.0.1:8080 (the default — Burp creates this
   automatically on first launch).

3. Point your browser at that proxy — either:
     a) Use Burp's built-in browser: Proxy > Intercept tab > "Open Browser".
        It's pre-configured to route through 127.0.0.1:8080 already.
     b) Or configure your own browser's network/proxy settings to use
        HTTP proxy 127.0.0.1 port 8080 for all traffic.

4. This app is plain HTTP on localhost (no TLS), so Burp's CA certificate
   does NOT need to be installed for the app itself. Only install it
   (http://burp on 127.0.0.1:8080, or Proxy > Proxy settings > Import /
   export CA certificate) if you also want to inspect an HTTPS hop, e.g.
   the Google OAuth redirect to accounts.google.com.

5. Browse to:  http://localhost:5173
   Use "localhost", not "127.0.0.1" or any other alias, on BOTH the
   frontend and API — the auth cookies are SameSite=Strict, and the
   backend's CORS is locked to FRONTEND_ORIGIN
   (${env.FRONTEND_ORIGIN}). Same hostname across both origins is what
   keeps the browser treating frontend<->API calls as same-site despite
   the different ports, and the proxy sitting in the middle doesn't change
   any of that — it only inspects/replays the same requests the browser
   would send anyway.

6. Log in once as each seeded account so both sessions show up in
   Proxy > HTTP history:
     Member:     ${TEST_USERS[0].email} / ${TEST_USERS[0].password}
     Librarian:  ${TEST_USERS[1].email} / ${TEST_USERS[1].password}

7. Burp Suite > Target > Scope: add http://localhost:5173 and
   http://localhost:5000 so passive/active scanning and Proxy > HTTP
   history stay limited to this app.
`);

  process.exit(0);
}

main().catch((err) => {
  console.error('Seeding failed:', err);
  process.exit(1);
});
