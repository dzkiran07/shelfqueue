const mongoose = require('mongoose');

const { Schema } = mongoose;

const loanSchema = new Schema(
  {
    bookId: { type: Schema.Types.ObjectId, ref: 'Book', required: true },
    memberId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requestedAt: { type: Date, default: Date.now, required: true },
    // Computed as approval time + loan period (Phase 18) — null until approved.
    dueDate: { type: Date },
    status: {
      type: String,
      enum: [
        'requested',
        'approved',
        'checked_out',
        'returned',
        'overdue',
        'lost',
        'damaged',
        'cancelled',
      ],
      default: 'requested',
      required: true,
    },
    // Sanitized on write (Phase 13). Only the general member-facing update
    // path may touch this — status transitions never share that code path
    // (Phase 20).
    memberNote: { type: String, trim: true },
    librarianNote: { type: String, trim: true },
    conditionOnReturn: { type: String, trim: true },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decidedAt: { type: Date },
    checkedOutAt: { type: Date },
    returnedAt: { type: Date },
  },
  { timestamps: true }
);

// Supports the overdue sweep (find checked_out loans past dueDate) and
// per-book status lookups (e.g. "is there a copy free right now").
loanSchema.index({ bookId: 1, status: 1 });
loanSchema.index({ memberId: 1, status: 1 });

module.exports = mongoose.model('Loan', loanSchema);
