const passport = require('passport');
const { Strategy: GoogleStrategy } = require('passport-google-oauth20');
const env = require('../config/env');

// This app never uses passport sessions (session: false everywhere) — it
// already has its own JWT-cookie session system (tokenService). The verify
// callback deliberately does no DB work: it just hands the raw Google
// profile through via done(), so the route controller owns account lookup/
// creation/linking and can produce the right response for each of the
// three cases the spec calls for (existing linked user, email-conflict,
// brand-new account).
passport.use(
  new GoogleStrategy(
    {
      clientID: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      callbackURL: `${env.BACKEND_ORIGIN}/api/auth/google/callback`,
    },
    (accessToken, refreshToken, profile, done) => {
      return done(null, profile);
    }
  )
);

module.exports = passport;
