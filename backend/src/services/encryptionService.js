const crypto = require('crypto');
const env = require('../config/env');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96-bit IV, the recommended size for GCM

function getKey() {
  const key = Buffer.from(env.MFA_ENCRYPTION_KEY || '', 'hex');
  if (key.length !== 32) {
    throw new Error('MFA_ENCRYPTION_KEY must be a 32-byte key, hex-encoded (64 hex characters)');
  }
  return key;
}

/**
 * AES-256-GCM encrypt. A fresh random IV is generated per call — reusing an
 * IV with the same key would break GCM's confidentiality guarantees, so it
 * travels alongside the ciphertext rather than being fixed or derived.
 * Returns "iv:authTag:ciphertext" (all hex) — none of the three pieces are
 * secret on their own without the key, so storing them together is safe.
 */
function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [iv, authTag, ciphertext].map((buf) => buf.toString('hex')).join(':');
}

/**
 * AES-256-GCM decrypt. Throws if the auth tag doesn't verify — GCM is
 * authenticated, so tampered or corrupted ciphertext is rejected rather
 * than silently decrypting to garbage.
 */
function decrypt(payload) {
  const key = getKey();
  const [ivHex, authTagHex, ciphertextHex] = String(payload).split(':');
  if (!ivHex || !authTagHex || !ciphertextHex) {
    throw new Error('Malformed encrypted payload');
  }

  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');
  const ciphertext = Buffer.from(ciphertextHex, 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return plaintext.toString('utf8');
}

module.exports = { encrypt, decrypt };
