const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const User = require('../models/User');
const {
  validatePasswordPolicy,
  getPasswordStrength,
  hashPassword,
  pushPasswordHistory,
} = require('../services/passwordPolicy');
const tokenService = require('../services/tokenService');
const mfaService = require('../services/mfaService');
const passport = require('../services/oauthService');
const env = require('../config/env');
const { redisClient } = require('../config/redis');
const { logActivity } = require('../middleware/auditLogger');
const securityMonitorService = require('../services/securityMonitorService');
const passwordResetService = require('../services/passwordResetService');
const emailService = require('../services/emailService');
const webauthnService = require('../services/webauthnService');
const { sanitizeHtml } = require('../middleware/sanitize');
const logger = require('../utils/logger');

const ACCOUNT_LOCKOUT_THRESHOLD = 12;
const ACCOUNT_LOCKOUT_BASE_MINUTES = 15;
const ACCOUNT_LOCKOUT_MAX_MINUTES = 24 * 60; // cap runaway exponential growth at 24h

const IP_FAILURE_WINDOW_SECONDS = 10 * 60;
const IP_FAILURE_THRESHOLD = 20;
const IP_BLOCK_SECONDS = 15 * 60;

// Doubles per repeat lockout (15m, 30m, 60m, ...) so an account under
// sustained attack gets progressively harder to keep hammering.
function computeLockoutDurationMs(priorLockoutCount) {
  const minutes = Math.min(
    ACCOUNT_LOCKOUT_BASE_MINUTES * 2 ** priorLockoutCount,
    ACCOUNT_LOCKOUT_MAX_MINUTES
  );
  return minutes * 60 * 1000;
}

function getClientIp(req) {
  return req.ip;
}

function isAllowedIp(ip) {
  return env.ALLOWED_IPS.includes(ip);
}

function ipFailureKey(ip) {
  return `ip-fail:${ip}`;
}
function ipBlockKey(ip) {
  return `ip-block:${ip}`;
}

async function isIpBlocked(ip) {
  return Boolean(await redisClient.get(ipBlockKey(ip)));
}

// Sliding-window-ish failure counter: an IP that racks up enough failed
// logins across ANY accounts (not just one) within the window gets blocked
// outright — this catches credential-stuffing spread across many emails,
// which per-account lockout alone wouldn't.
async function recordIpFailure(ip) {
  const key = ipFailureKey(ip);
  const count = await redisClient.incr(key);
  if (count === 1) {
    await redisClient.expire(key, IP_FAILURE_WINDOW_SECONDS);
  }
  if (count >= IP_FAILURE_THRESHOLD) {
    await redisClient.set(ipBlockKey(ip), '1', { EX: IP_BLOCK_SECONDS });
  }
}

const MAX_STRENGTH_CHECK_PASSWORD_LENGTH = 128;

// Unauthenticated by design (called while the registration form is still
// being filled in, before any account exists) and deliberately cheap to
// abuse-proof: no DB access, no captcha (that would defeat live-as-you-type
// feedback), just a length clamp ahead of zxcvbn's own cost plus the global
// rate limiter already mounted ahead of every route.
function passwordStrengthCheck(req, res) {
  const { password, name, email } = req.body || {};
  const candidate = typeof password === 'string' ? password.slice(0, MAX_STRENGTH_CHECK_PASSWORD_LENGTH) : '';
  const strength = getPasswordStrength(candidate, [name, email]);
  return res.status(200).json(strength);
}

async function register(req, res, next) {
  try {
    const { name, email, password } = req.body || {};

    if (!name || !email || !password) {
      return res.status(400).json({ error: 'name, email, and password are required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const trimmedName = String(name).trim();

    const existing = await User.findOne({ email: normalizedEmail });
    if (existing) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const passwordStrength = getPasswordStrength(password, [trimmedName, normalizedEmail]);

    const { valid, errors } = await validatePasswordPolicy({
      password,
      email: normalizedEmail,
      name: trimmedName,
      passwordHistory: [],
    });

    if (!valid) {
      return res.status(400).json({ errors, passwordStrength });
    }

    const passwordHash = await hashPassword(password);

    const user = await User.create({
      name: trimmedName,
      email: normalizedEmail,
      passwordHash,
      passwordHistory: [passwordHash],
      passwordChangedAt: new Date(),
    });

    await logActivity({
      actorId: user._id,
      action: 'user_registered',
      resourceType: 'User',
      resourceId: user._id,
      req,
    });

    // 201 with only non-sensitive fields — no passwordHash, no tokens (login
    // isn't wired up until Phase 5).
    return res.status(201).json({
      message: 'Registration successful',
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      passwordStrength,
    });
  } catch (err) {
    return next(err);
  }
}

async function login(req, res, next) {
  try {
    const ip = getClientIp(req);
    const ipAllowListed = isAllowedIp(ip);

    if (!ipAllowListed && (await isIpBlocked(ip))) {
      return res
        .status(429)
        .json({ error: 'Too many failed attempts from this network. Please try again later.' });
    }

    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'email and password are required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail }).select('+passwordHash');

    // Same generic message whether the account doesn't exist, the password
    // is wrong, or (below) the account happens to be locked — so the
    // response itself can never be used to enumerate registered emails or
    // confirm a lockout state to someone who hasn't proven they know the
    // password.
    const rejectInvalidCredentials = async () => {
      if (!ipAllowListed) {
        await recordIpFailure(ip);
        await securityMonitorService.recordFailedLogin(ip);
      }
      await logActivity({
        actorId: user?._id,
        action: 'login_failure',
        resourceType: 'User',
        resourceId: user?._id,
        req,
      });
      return res.status(401).json({ error: 'Invalid email or password' });
    };

    if (!user || !user.passwordHash) {
      return rejectInvalidCredentials();
    }

    const isCurrentlyLocked = user.lockoutUntil && user.lockoutUntil > new Date();

    if (isCurrentlyLocked) {
      // Only reveal the lockout state to someone who has already proven
      // they know the password for this account — to anyone else the
      // response is identical to "invalid email or password".
      const passwordMatches = await bcrypt.compare(password, user.passwordHash);
      if (passwordMatches) {
        await logActivity({
          actorId: user._id,
          action: 'login_blocked_lockout',
          resourceType: 'User',
          resourceId: user._id,
          req,
        });
        return res.status(403).json({
          error: 'Account temporarily locked due to repeated failed login attempts. Please try again later.',
          lockoutUntil: user.lockoutUntil,
        });
      }
      return rejectInvalidCredentials();
    }

    const passwordMatches = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatches) {
      user.failedLoginAttempts += 1;

      if (user.failedLoginAttempts >= ACCOUNT_LOCKOUT_THRESHOLD) {
        user.lockoutUntil = new Date(Date.now() + computeLockoutDurationMs(user.lockoutCount));
        user.lockoutCount += 1;
        user.failedLoginAttempts = 0;

        await logActivity({
          actorId: user._id,
          action: 'account_lockout',
          resourceType: 'User',
          resourceId: user._id,
          req,
          metadata: { lockoutUntil: user.lockoutUntil, lockoutCount: user.lockoutCount },
        });
      }

      await user.save();
      return rejectInvalidCredentials();
    }

    if (user.status === 'suspended') {
      await logActivity({
        actorId: user._id,
        action: 'login_blocked_suspended',
        resourceType: 'User',
        resourceId: user._id,
        req,
      });
      return res.status(403).json({ error: 'This account has been suspended' });
    }

    // Password expiry: checked only after credentials are already proven
    // correct (same enumeration-safety principle as the lockout reveal
    // above) and before MFA, since there's no point continuing a login
    // that's going to be rejected anyway. A reset is required, not a
    // normal session — direct the client straight to that flow.
    const passwordAgeMs = user.passwordChangedAt ? Date.now() - user.passwordChangedAt.getTime() : 0;
    const passwordExpired = passwordAgeMs > env.PASSWORD_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

    if (passwordExpired) {
      await logActivity({
        actorId: user._id,
        action: 'login_blocked_password_expired',
        resourceType: 'User',
        resourceId: user._id,
        req,
      });
      return res.status(403).json({
        error: 'Your password has expired and must be reset before you can log in.',
        passwordExpired: true,
      });
    }

    // Success — reset brute-force counters for this account.
    user.failedLoginAttempts = 0;
    user.lastLogin = new Date();
    await user.save();

    if (user.mfaEnabled) {
      // Password was correct, but that alone isn't enough to issue a
      // session for an MFA-enabled account. Hand back a short-lived,
      // body-only token (never a cookie) that only /mfa/challenge accepts,
      // instead of the real access/refresh cookies.
      await logActivity({
        actorId: user._id,
        action: 'login_mfa_required',
        resourceType: 'User',
        resourceId: user._id,
        req,
      });
      return res.status(200).json({
        mfaRequired: true,
        mfaPendingToken: tokenService.signMfaPendingToken(user._id),
      });
    }

    const { accessToken, refreshToken } = await tokenService.issueSession(user._id, {
      fingerprint: tokenService.computeDeviceFingerprint(req),
      userAgent: req.headers['user-agent'],
    });
    tokenService.setAuthCookies(res, { accessToken, refreshToken });

    await logActivity({
      actorId: user._id,
      action: 'login_success',
      resourceType: 'User',
      resourceId: user._id,
      req,
    });

    return res.status(200).json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    return next(err);
  }
}

const FORGOT_PASSWORD_GENERIC_RESPONSE = {
  message: 'If an account with that email exists, a password reset link has been sent.',
};

/**
 * Always returns the same generic response whether or not the account
 * exists — that response is the actual enumeration defense; everything
 * below it (token issuance, emailing) only ever happens server-side and is
 * invisible to the caller either way.
 */
async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    if (user) {
      const rawToken = await passwordResetService.createResetToken(user._id);
      const resetUrl = `${env.FRONTEND_ORIGIN}/reset-password/${rawToken}`;

      try {
        await emailService.sendPasswordResetEmail(user.email, resetUrl);
      } catch (err) {
        // An email-sending hiccup must not fail the request (that would
        // leak account existence via a different response) or surface any
        // detail to the client — log server-side and move on.
        logger.error(`Failed to send password reset email: ${err.message}`);
      }

      await logActivity({
        actorId: user._id,
        action: 'password_reset_requested',
        resourceType: 'User',
        resourceId: user._id,
        req,
      });
    }

    return res.status(200).json(FORGOT_PASSWORD_GENERIC_RESPONSE);
  } catch (err) {
    return next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const { token } = req.params;
    const { password } = req.body || {};

    if (!token || !password) {
      return res.status(400).json({ error: 'token and password are required' });
    }

    // Single-use: consumeResetToken deletes the token the moment it's
    // looked up, regardless of what happens next, so a client retrying
    // with the same link after a policy-validation failure below gets
    // "invalid or expired token", not a second chance at the same token.
    const userId = await passwordResetService.consumeResetToken(token);
    if (!userId) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const user = await User.findById(userId).select('+passwordHash +passwordHistory');
    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const { valid, errors } = await validatePasswordPolicy({
      password,
      email: user.email,
      name: user.name,
      passwordHistory: user.passwordHistory,
    });

    if (!valid) {
      return res.status(400).json({ errors });
    }

    const passwordHash = await hashPassword(password);
    user.passwordHash = passwordHash;
    user.passwordHistory = pushPasswordHistory(user.passwordHistory, passwordHash);
    user.passwordChangedAt = new Date();
    // A successful reset is itself strong proof the person completing it
    // isn't the one who was failing to log in — clear any lockout state
    // rather than leaving them locked out right after proving account
    // ownership via email.
    user.failedLoginAttempts = 0;
    user.lockoutUntil = null;
    await user.save();

    // Force every existing session to re-authenticate — a password reset
    // is exactly the moment a stolen session (if any) should stop working
    // immediately, not linger until it naturally expires.
    await tokenService.revokeAllSessions(user._id);

    await logActivity({
      actorId: user._id,
      action: 'password_reset_completed',
      resourceType: 'User',
      resourceId: user._id,
      req,
    });

    return res.status(200).json({ message: 'Password has been reset. Please log in again.' });
  } catch (err) {
    return next(err);
  }
}

async function mfaSetup(req, res, next) {
  try {
    const { user } = req;

    if (user.mfaEnabled) {
      return res.status(400).json({ error: 'MFA is already enabled for this account' });
    }

    const secret = mfaService.generateSecret();
    user.mfaSecretEncrypted = mfaService.encryptSecret(secret);
    // mfaEnabled stays false until verify-setup proves the user actually
    // has this secret loaded in an authenticator app.
    await user.save();

    const otpauthUrl = mfaService.buildOtpAuthUrl(secret, user.email);
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    return res.status(200).json({ otpauthUrl, qrCodeDataUrl });
  } catch (err) {
    return next(err);
  }
}

async function mfaVerifySetup(req, res, next) {
  try {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ error: 'A verification code is required' });
    }

    const user = await User.findById(req.user._id).select('+mfaSecretEncrypted');
    if (!user || !user.mfaSecretEncrypted) {
      return res.status(400).json({ error: 'MFA setup has not been started for this account' });
    }
    if (user.mfaEnabled) {
      return res.status(400).json({ error: 'MFA is already enabled for this account' });
    }

    const secret = mfaService.decryptSecret(user.mfaSecretEncrypted);
    const valid = mfaService.verifyToken(token, secret);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    user.mfaEnabled = true;
    await user.save();

    return res.status(200).json({ status: 'MFA enabled' });
  } catch (err) {
    return next(err);
  }
}

async function mfaChallenge(req, res, next) {
  try {
    const { mfaPendingToken, token } = req.body || {};
    if (!mfaPendingToken || !token) {
      return res.status(400).json({ error: 'mfaPendingToken and token are required' });
    }

    let payload;
    try {
      payload = tokenService.verifyMfaPendingToken(mfaPendingToken);
    } catch (err) {
      // No reliably-known actor here — the pending token itself didn't
      // verify, so there's no trustworthy subject id to attach.
      await logActivity({ action: 'mfa_challenge_failure', req });
      return res.status(401).json({ error: 'Invalid or expired MFA challenge' });
    }

    const user = await User.findById(payload.sub).select('+mfaSecretEncrypted');
    if (!user || !user.mfaEnabled || !user.mfaSecretEncrypted) {
      await logActivity({
        actorId: payload.sub,
        action: 'mfa_challenge_failure',
        resourceType: 'User',
        resourceId: payload.sub,
        req,
      });
      return res.status(401).json({ error: 'Invalid or expired MFA challenge' });
    }
    if (user.status === 'suspended') {
      await logActivity({
        actorId: user._id,
        action: 'login_blocked_suspended',
        resourceType: 'User',
        resourceId: user._id,
        req,
      });
      return res.status(403).json({ error: 'This account has been suspended' });
    }

    const secret = mfaService.decryptSecret(user.mfaSecretEncrypted);
    const valid = mfaService.verifyToken(token, secret);
    if (!valid) {
      await logActivity({
        actorId: user._id,
        action: 'mfa_challenge_failure',
        resourceType: 'User',
        resourceId: user._id,
        req,
      });
      return res.status(401).json({ error: 'Invalid verification code' });
    }

    const { accessToken, refreshToken } = await tokenService.issueSession(user._id, {
      fingerprint: tokenService.computeDeviceFingerprint(req),
      userAgent: req.headers['user-agent'],
    });
    tokenService.setAuthCookies(res, { accessToken, refreshToken });

    await logActivity({
      actorId: user._id,
      action: 'mfa_challenge_success',
      resourceType: 'User',
      resourceId: user._id,
      req,
    });
    await logActivity({
      actorId: user._id,
      action: 'login_success',
      resourceType: 'User',
      resourceId: user._id,
      req,
    });

    return res.status(200).json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    return next(err);
  }
}

// --- WebAuthn / passkeys (Phase 25) ----------------------------------------
// Offered alongside password-based login, never as a replacement: not every
// user has hardware or a platform authenticator that supports it, so the
// password + MFA path must keep working unconditionally regardless of
// whether a given account also has passkeys enrolled.

async function webauthnRegisterOptions(req, res, next) {
  try {
    const options = await webauthnService.buildRegistrationOptions(req.user);
    return res.status(200).json(options);
  } catch (err) {
    return next(err);
  }
}

async function webauthnRegisterVerify(req, res, next) {
  try {
    const { response, deviceLabel } = req.body || {};
    if (!response) {
      return res.status(400).json({ error: 'response is required' });
    }

    const result = await webauthnService.verifyRegistration(req.user, response);
    if (!result.verified) {
      return res.status(400).json({ error: 'WebAuthn registration verification failed' });
    }

    const { credential } = result;
    const alreadyRegistered = req.user.webauthnCredentials.some((c) => c.credentialId === credential.id);
    if (alreadyRegistered) {
      return res.status(409).json({ error: 'This authenticator is already registered to your account' });
    }

    req.user.webauthnCredentials.push({
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64'),
      counter: credential.counter,
      transports: credential.transports || [],
      deviceLabel: deviceLabel ? sanitizeHtml(String(deviceLabel)).slice(0, 100) : undefined,
    });
    await req.user.save();

    await logActivity({
      actorId: req.user._id,
      action: 'webauthn_credential_registered',
      resourceType: 'User',
      resourceId: req.user._id,
      req,
    });

    return res.status(201).json({ status: 'Authenticator registered' });
  } catch (err) {
    return next(err);
  }
}

async function webauthnLoginOptions(req, res, next) {
  try {
    const { email } = req.body || {};
    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    const options = await webauthnService.buildAuthenticationOptions(user, normalizedEmail);
    return res.status(200).json(options);
  } catch (err) {
    return next(err);
  }
}

async function webauthnLoginVerify(req, res, next) {
  try {
    const { email, response } = req.body || {};
    if (!email || !response) {
      return res.status(400).json({ error: 'email and response are required' });
    }

    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await User.findOne({ email: normalizedEmail });

    const genericFailure = () => res.status(401).json({ error: 'Passkey sign-in failed' });

    const result = await webauthnService.verifyAuthentication(user, normalizedEmail, response);
    if (!result.verified) {
      return genericFailure();
    }

    // Persisting the bumped signature counter is the actual replay
    // defense, so it happens immediately and unconditionally — before any
    // check below that might reject the login for an unrelated reason
    // (suspended, MFA-pending).
    result.storedCredential.counter = result.newCounter;
    await user.save();

    if (user.status === 'suspended') {
      await logActivity({
        actorId: user._id,
        action: 'login_blocked_suspended',
        resourceType: 'User',
        resourceId: user._id,
        req,
      });
      return res.status(403).json({ error: 'This account has been suspended' });
    }

    await logActivity({
      actorId: user._id,
      action: 'webauthn_login_success',
      resourceType: 'User',
      resourceId: user._id,
      req,
    });

    if (user.mfaEnabled) {
      await logActivity({
        actorId: user._id,
        action: 'login_mfa_required',
        resourceType: 'User',
        resourceId: user._id,
        req,
      });
      return res.status(200).json({
        mfaRequired: true,
        mfaPendingToken: tokenService.signMfaPendingToken(user._id),
      });
    }

    user.lastLogin = new Date();
    await user.save();

    const { accessToken, refreshToken } = await tokenService.issueSession(user._id, {
      fingerprint: tokenService.computeDeviceFingerprint(req),
      userAgent: req.headers['user-agent'],
    });
    tokenService.setAuthCookies(res, { accessToken, refreshToken });

    await logActivity({
      actorId: user._id,
      action: 'login_success',
      resourceType: 'User',
      resourceId: user._id,
      req,
    });

    return res.status(200).json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    return next(err);
  }
}

function googleLoginStart(req, res, next) {
  return passport.authenticate('google', { scope: ['profile', 'email'], session: false })(
    req,
    res,
    next
  );
}

// Authenticated-only: starts the "Connect Google" flow from a logged-in
// user's profile settings. The current user's id travels through Google's
// `state` round-trip (see tokenService.signOauthLinkToken) since our own
// SameSite=Strict session cookie won't survive the cross-site redirect back
// from accounts.google.com.
function googleLinkStart(req, res, next) {
  const state = tokenService.signOauthLinkToken(req.user._id);
  return passport.authenticate('google', {
    scope: ['profile', 'email'],
    session: false,
    state,
  })(req, res, next);
}

async function googleCallback(req, res, next) {
  try {
    const profile = req.user; // set by passport's verify callback (raw Google profile)
    const googleId = profile.id;
    const email = profile.emails?.[0]?.value?.trim().toLowerCase();
    const name = profile.displayName || email;

    if (!email) {
      return res.redirect(`${env.FRONTEND_ORIGIN}/login?oauthError=no_email`);
    }

    let linkUserId = null;
    if (req.query.state) {
      try {
        linkUserId = tokenService.verifyOauthLinkToken(req.query.state).sub;
      } catch (err) {
        // Invalid/expired/forged state — fall through and treat this as a
        // normal (non-linking) OAuth attempt rather than trusting it.
      }
    }

    const existingLink = await User.findOne({
      oauthProviders: { $elemMatch: { provider: 'google', providerId: googleId } },
    });

    if (linkUserId) {
      // Authenticated "Connect Google" flow.
      if (existingLink && String(existingLink._id) !== linkUserId) {
        return res.redirect(`${env.FRONTEND_ORIGIN}/settings?oauthError=already_linked_elsewhere`);
      }

      const user = await User.findById(linkUserId);
      if (!user) {
        return res.redirect(`${env.FRONTEND_ORIGIN}/settings?oauthError=link_failed`);
      }

      const alreadyLinked = user.oauthProviders.some((p) => p.provider === 'google');
      if (!alreadyLinked) {
        user.oauthProviders.push({ provider: 'google', providerId: googleId });
        await user.save();
      }

      return res.redirect(`${env.FRONTEND_ORIGIN}/settings?oauthLinked=true`);
    }

    // Plain login/registration flow.
    let user = existingLink;

    if (!user) {
      const existingLocal = await User.findOne({ email });
      if (existingLocal) {
        // Do NOT auto-link: this app has no email-verification flow, so
        // treating "same email" as "same person" here would let anyone who
        // controls a Google account with a matching email silently take
        // over a local account. Direct them to log in with their password
        // first and link from an authenticated settings action instead.
        return res.redirect(`${env.FRONTEND_ORIGIN}/login?oauthError=email_registered`);
      }

      // Brand-new account, OAuth-only — no passwordHash. The user can still
      // add MFA (Phase 7) and set a password later via profile settings,
      // since neither of those code paths assumes passwordHash exists.
      user = await User.create({
        name,
        email,
        oauthProviders: [{ provider: 'google', providerId: googleId }],
      });
    }

    if (user.status === 'suspended') {
      return res.redirect(`${env.FRONTEND_ORIGIN}/login?oauthError=suspended`);
    }

    user.lastLogin = new Date();
    await user.save();

    const { accessToken, refreshToken } = await tokenService.issueSession(user._id, {
      fingerprint: tokenService.computeDeviceFingerprint(req),
      userAgent: req.headers['user-agent'],
    });
    tokenService.setAuthCookies(res, { accessToken, refreshToken });

    return res.redirect(`${env.FRONTEND_ORIGIN}/oauth/callback?status=success`);
  } catch (err) {
    return next(err);
  }
}

async function refresh(req, res, next) {
  try {
    const refreshToken = req.cookies?.[tokenService.REFRESH_TOKEN_COOKIE];
    if (!refreshToken) {
      return res.status(401).json({ error: 'No refresh token provided' });
    }

    const result = await tokenService.rotateRefreshToken(refreshToken, {
      fingerprint: tokenService.computeDeviceFingerprint(req),
    });

    if (result.status === 'reused') {
      tokenService.clearAuthCookies(res);
      return res.status(401).json({ error: 'Session revoked — please log in again' });
    }

    if (result.status === 'device_mismatch') {
      tokenService.clearAuthCookies(res);
      return res
        .status(401)
        .json({ error: 'Session revoked — refresh attempted from an unrecognized device' });
    }

    if (result.status !== 'ok') {
      tokenService.clearAuthCookies(res);
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    // Re-check the user still exists and isn't suspended before honoring
    // the rotation — otherwise a leaked refresh token for a since-suspended
    // account would keep minting valid sessions until it naturally expires.
    const user = await User.findById(result.userId);
    if (!user || user.status === 'suspended') {
      await tokenService.revokeSession(result.userId, result.familyId);
      tokenService.clearAuthCookies(res);
      return res.status(401).json({ error: 'Invalid or expired refresh token' });
    }

    tokenService.setAuthCookies(res, result.tokens);
    return res.status(200).json({ status: 'refreshed' });
  } catch (err) {
    return next(err);
  }
}

async function listSessions(req, res, next) {
  try {
    const sessions = await tokenService.listSessions(req.user._id);
    return res.status(200).json({ sessions });
  } catch (err) {
    return next(err);
  }
}

async function revokeSessionById(req, res, next) {
  try {
    const { id: familyId } = req.params;

    // Scoped to req.user._id by construction — the Redis key looked up is
    // session:{req.user._id}:{familyId}, so a user can never revoke another
    // user's session even by guessing a valid familyId; there's no matching
    // key in their own namespace unless it's genuinely theirs.
    await tokenService.revokeSession(req.user._id, familyId);

    // If the caller just revoked the session they're currently using,
    // clear their cookies too so the client doesn't keep sending a
    // refresh token that's already dead.
    const currentRefreshToken = req.cookies?.[tokenService.REFRESH_TOKEN_COOKIE];
    if (currentRefreshToken) {
      try {
        const payload = tokenService.verifyRefreshToken(currentRefreshToken);
        if (payload.familyId === familyId) {
          tokenService.clearAuthCookies(res);
        }
      } catch (err) {
        // Current cookie already invalid — nothing extra to clear.
      }
    }

    return res.status(200).json({ status: 'revoked' });
  } catch (err) {
    return next(err);
  }
}

// req.user is already the freshly-refetched, zero-trust document attached
// by requireAuth — this endpoint just reshapes it for the frontend's
// app-load bootstrap (AuthContext), same minimal shape login/register use.
function getCurrentUser(req, res) {
  return res.status(200).json({
    user: {
      id: req.user._id,
      name: req.user.name,
      email: req.user.email,
      role: req.user.role,
    },
  });
}

async function logout(req, res, next) {
  try {
    const refreshToken = req.cookies?.[tokenService.REFRESH_TOKEN_COOKIE];

    if (refreshToken) {
      try {
        const payload = tokenService.verifyRefreshToken(refreshToken);
        await tokenService.revokeSession(payload.sub, payload.familyId);
      } catch (err) {
        // Token already invalid/expired — nothing to revoke server-side,
        // logout still succeeds from the client's point of view.
      }
    }

    tokenService.clearAuthCookies(res);
    return res.status(200).json({ status: 'logged out' });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  passwordStrengthCheck,
  register,
  login,
  forgotPassword,
  resetPassword,
  refresh,
  logout,
  getCurrentUser,
  mfaSetup,
  mfaVerifySetup,
  mfaChallenge,
  webauthnRegisterOptions,
  webauthnRegisterVerify,
  webauthnLoginOptions,
  webauthnLoginVerify,
  googleLoginStart,
  googleLinkStart,
  googleCallback,
  listSessions,
  revokeSessionById,
};
