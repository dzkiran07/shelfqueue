const mongoose = require('mongoose');

const { Schema } = mongoose;

const securityAlertSchema = new Schema(
  {
    type: { type: String, required: true, trim: true },
    ip: { type: String, trim: true },
    details: { type: String, trim: true },
    timestamp: { type: Date, default: Date.now, required: true },
    resolved: { type: Boolean, default: false },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    resolvedAt: { type: Date },
  },
  { timestamps: false }
);

securityAlertSchema.index({ resolved: 1, timestamp: -1 });
securityAlertSchema.index({ ip: 1 });

module.exports = mongoose.model('SecurityAlert', securityAlertSchema);
