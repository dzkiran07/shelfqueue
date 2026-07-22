const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const { redisClient } = require('../config/redis');
const env = require('../config/env');

const CHALLENGE_TTL_SECONDS = 5 * 60;

function challengeKey(ownerKey, purpose) {
  return `webauthn-challenge:${purpose}:${ownerKey}`;
}

async function storeChallenge(ownerKey, purpose, challenge) {
  await redisClient.set(challengeKey(ownerKey, purpose), challenge, { EX: CHALLENGE_TTL_SECONDS });
}

async function consumeChallenge(ownerKey, purpose) {
  const key = challengeKey(ownerKey, purpose);
  const challenge = await redisClient.get(key);
  if (challenge) {
    await redisClient.del(key);
  }
  return challenge;
}

/**
 * Builds options for navigator.credentials.create() so an already-
 * logged-in user can enroll a new authenticator. excludeCredentials lists
 * their already-registered credentials so the same physical authenticator
 * can't be enrolled twice.
 */
async function buildRegistrationOptions(user) {
  const options = await generateRegistrationOptions({
    rpName: env.WEBAUTHN_RP_NAME,
    rpID: env.WEBAUTHN_RP_ID,
    userName: user.email,
    userID: new Uint8Array(Buffer.from(String(user._id), 'utf8')),
    userDisplayName: user.name,
    attestationType: 'none',
    excludeCredentials: (user.webauthnCredentials || []).map((cred) => ({
      id: cred.credentialId,
      transports: cred.transports,
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
    },
  });

  await storeChallenge(String(user._id), 'registration', options.challenge);
  return options;
}

/**
 * Verifies a completed registration ceremony against the challenge stored
 * for this user. Returns the new credential's { id, publicKey, counter,
 * transports } for the caller to persist — this function doesn't touch
 * the database itself, since ownership of the User document (and its
 * save()) belongs to the controller.
 */
async function verifyRegistration(user, response) {
  const expectedChallenge = await consumeChallenge(String(user._id), 'registration');
  if (!expectedChallenge) {
    return { verified: false, reason: 'challenge_expired' };
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: env.FRONTEND_ORIGIN,
      expectedRPID: env.WEBAUTHN_RP_ID,
    });
  } catch (err) {
    return { verified: false, reason: 'verification_error' };
  }

  if (!verification.verified || !verification.registrationInfo) {
    return { verified: false, reason: 'verification_failed' };
  }

  return { verified: true, credential: verification.registrationInfo.credential };
}

// There's no userId to key the login challenge by until we know which
// account the caller claims to be signing into — for a real account this
// is just its id; for a nonexistent one, a key derived from the (already
// client-known) email keeps the options/verify round-trip consistent
// without ever needing to tell the client whether the account exists.
function authChallengeOwnerKey(user, normalizedEmail) {
  return user ? String(user._id) : `email:${normalizedEmail}`;
}

/**
 * Builds options for navigator.credentials.get() for passwordless login.
 * Deliberately produces a validly-shaped response with a real, stored
 * challenge regardless of whether the account exists or has any
 * authenticators enrolled — an empty allowCredentials list just means the
 * browser won't find a matching authenticator, and the flow dies
 * client-side without the server ever confirming account existence via a
 * different response shape (the same enumeration-safety principle used
 * throughout this app's auth flows).
 */
async function buildAuthenticationOptions(user, normalizedEmail) {
  const hasCredentials = Boolean(user?.webauthnCredentials?.length);

  const options = await generateAuthenticationOptions({
    rpID: env.WEBAUTHN_RP_ID,
    userVerification: 'preferred',
    allowCredentials: hasCredentials
      ? user.webauthnCredentials.map((cred) => ({ id: cred.credentialId, transports: cred.transports }))
      : [],
  });

  await storeChallenge(authChallengeOwnerKey(user, normalizedEmail), 'authentication', options.challenge);
  return options;
}

/**
 * Verifies a completed authentication ceremony. The matching stored
 * credential is looked up by the response's own credential id and handed
 * to @simplewebauthn/server explicitly — this library (v13) doesn't look
 * credentials up itself, callers own that lookup. Returns the stored
 * credential subdocument and the new counter for the caller to persist;
 * persisting the bumped counter is the actual defense against a cloned
 * authenticator replaying an old signature, so the controller must save it
 * regardless of what happens afterward (suspended check, MFA, etc.).
 */
async function verifyAuthentication(user, normalizedEmail, response) {
  const expectedChallenge = await consumeChallenge(authChallengeOwnerKey(user, normalizedEmail), 'authentication');
  if (!expectedChallenge || !user) {
    return { verified: false };
  }

  const storedCredential = (user.webauthnCredentials || []).find((c) => c.credentialId === response?.id);
  if (!storedCredential) {
    return { verified: false };
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: env.FRONTEND_ORIGIN,
      expectedRPID: env.WEBAUTHN_RP_ID,
      credential: {
        id: storedCredential.credentialId,
        publicKey: new Uint8Array(Buffer.from(storedCredential.publicKey, 'base64')),
        counter: storedCredential.counter,
        transports: storedCredential.transports,
      },
    });
  } catch (err) {
    return { verified: false };
  }

  if (!verification.verified) {
    return { verified: false };
  }

  return { verified: true, storedCredential, newCounter: verification.authenticationInfo.newCounter };
}

module.exports = {
  buildRegistrationOptions,
  verifyRegistration,
  buildAuthenticationOptions,
  verifyAuthentication,
};
