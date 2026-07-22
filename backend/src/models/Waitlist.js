const mongoose = require('mongoose');

const { Schema } = mongoose;

const waitlistSchema = new Schema(
  {
    bookId: { type: Schema.Types.ObjectId, ref: 'Book', required: true },
    memberId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    // Sequential position within this book's queue (Phase 19).
    queuePosition: { type: Number, required: true },
    status: {
      type: String,
      enum: ['waiting', 'offered', 'expired', 'fulfilled', 'cancelled'],
      default: 'waiting',
      required: true,
    },
    offeredAt: { type: Date },
    // Claim window deadline (e.g. offeredAt + 48h) — swept by the expiry job.
    offerExpiresAt: { type: Date },
  },
  { timestamps: true }
);

// Ordered queue lookups per book, and fast "earliest waiting entry" queries
// when a copy frees up.
waitlistSchema.index({ bookId: 1, queuePosition: 1 });
waitlistSchema.index({ bookId: 1, status: 1 });
waitlistSchema.index({ memberId: 1, status: 1 });
// Enforced at the DB level, not just checked-then-inserted in application
// code: a member can only have one 'waiting' entry per book at a time.
// Without this, two concurrent join requests from the same member for the
// same book could both pass an application-level "do I already have an
// entry?" check before either had actually inserted one.
waitlistSchema.index(
  { bookId: 1, memberId: 1 },
  { unique: true, partialFilterExpression: { status: 'waiting' } }
);

module.exports = mongoose.model('Waitlist', waitlistSchema);
