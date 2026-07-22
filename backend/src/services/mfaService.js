const { authenticator } = require('otplib');
const encryptionService = require('./encryptionService');

const ISSUER = 'ShelfQueue';

function generateSecret() {
  return authenticator.generateSecret();
}

function buildOtpAuthUrl(secret, email) {
  return authenticator.keyuri(email, ISSUER, secret);
}

function verifyToken(token, secret) {
  try {
    // Strip whitespace some authenticator apps/clients render/copy the code
    // with (e.g. "123 456") — otplib compares the digit string exactly, so
    // an otherwise-correct code would be rejected without this.
    const cleaned = String(token).replace(/\s+/g, '');
    return authenticator.verify({ token: cleaned, secret });
  } catch (err) {
    // otplib throws on a malformed token rather than returning false —
    // treat any malformed input as simply "not valid" for callers.
    return false;
  }
}

function encryptSecret(secret) {
  return encryptionService.encrypt(secret);
}

function decryptSecret(encryptedSecret) {
  return encryptionService.decrypt(encryptedSecret);
}

module.exports = {
  generateSecret,
  buildOtpAuthUrl,
  verifyToken,
  encryptSecret,
  decryptSecret,
};
