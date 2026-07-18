const mongoose = require('mongoose');

const { Schema } = mongoose;

// Immutable append-only record — no updatedAt, entries are never edited.
// NEVER write passwordHash, mfaSecret, raw tokens, or OTP codes into
// `action`/resourceType or any other field here (Phase 21).
const auditLogSchema = new Schema(
  {
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    action: { type: String, required: true, trim: true },
    resourceType: { type: String, trim: true },
    resourceId: { type: Schema.Types.ObjectId },
    ip: { type: String, trim: true },
    userAgent: { type: String, trim: true },
    timestamp: { type: Date, default: Date.now, required: true },
  },
  { timestamps: false }
);

auditLogSchema.index({ actorId: 1, timestamp: -1 });
auditLogSchema.index({ action: 1, timestamp: -1 });
auditLogSchema.index({ resourceType: 1, resourceId: 1 });

module.exports = mongoose.model('AuditLog', auditLogSchema);
