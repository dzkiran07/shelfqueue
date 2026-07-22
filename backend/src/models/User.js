const mongoose = require('mongoose');

const { Schema } = mongoose;

const oauthProviderSchema = new Schema(
  {
    provider: { type: String, required: true }, // e.g. 'google'
    providerId: { type: String, required: true },
  },
  { _id: false }
);

// One entry per enrolled authenticator (Phase 25) — a user can register
// more than one (e.g. a phone passkey and a hardware security key).
const webauthnCredentialSchema = new Schema(
  {
    credentialId: { type: String, required: true }, // base64url, WebAuthnCredential.id
    publicKey: { type: String, required: true }, // base64-encoded raw public key bytes
    // Signature counter reported by the authenticator. Bumped on every
    // successful authentication; a value that doesn't strictly increase
    // is the standard signal of a cloned authenticator replaying an old
    // signature, which @simplewebauthn/server checks against this.
    counter: { type: Number, required: true, default: 0 },
    transports: { type: [String], default: [] },
    deviceLabel: { type: String, trim: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    // Self-service profile fields (Phase 15) — updatable only via the
    // explicit allow-list in user.controller.js, never via a raw spread.
    phone: { type: String, trim: true },
    notificationPreferences: {
      email: { type: Boolean, default: true },
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    // Absent for OAuth-only accounts that never set a local password.
    passwordHash: { type: String, select: false },
    // Capped at the last 5 hashes (Phase 4) so previous passwords can't be reused.
    passwordHistory: { type: [String], default: [], select: false },
    passwordChangedAt: { type: Date },
    role: {
      type: String,
      enum: ['member', 'librarian'],
      default: 'member',
      required: true,
    },
    mfaEnabled: { type: Boolean, default: false },
    // AES-256-GCM ciphertext + IV, never the raw TOTP secret (Phase 7/23).
    mfaSecretEncrypted: { type: String, select: false },
    oauthProviders: { type: [oauthProviderSchema], default: [] },
    webauthnCredentials: { type: [webauthnCredentialSchema], default: [] },
    failedLoginAttempts: { type: Number, default: 0 },
    lockoutUntil: { type: Date, default: null },
    // Count of prior lockouts, used to grow the lockout duration
    // exponentially on repeat offenses (Phase 6).
    lockoutCount: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['active', 'suspended'],
      default: 'active',
      required: true,
    },
    lastLogin: { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
