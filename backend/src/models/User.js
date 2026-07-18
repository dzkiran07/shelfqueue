const mongoose = require('mongoose');

const { Schema } = mongoose;

const oauthProviderSchema = new Schema(
  {
    provider: { type: String, required: true }, // e.g. 'google'
    providerId: { type: String, required: true },
  },
  { _id: false }
);

const userSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
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
    webauthnCredentials: { type: [Schema.Types.Mixed], default: [] }, // populated in Phase 25
    failedLoginAttempts: { type: Number, default: 0 },
    lockoutUntil: { type: Date, default: null },
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

userSchema.index({ email: 1 }, { unique: true });

module.exports = mongoose.model('User', userSchema);
