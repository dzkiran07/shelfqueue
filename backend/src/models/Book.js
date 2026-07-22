const mongoose = require('mongoose');

const { Schema } = mongoose;

const bookSchema = new Schema(
  {
    title: { type: String, required: true, trim: true },
    author: { type: String, required: true, trim: true },
    isbn: { type: String, required: true, trim: true },
    genre: { type: String, trim: true },
    // Sanitized on write (Phase 13) before being stored.
    description: { type: String, trim: true },
    coverUrl: { type: String, trim: true },
    totalCopies: { type: Number, required: true, min: 0 },
    copiesAvailable: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['active', 'retired'],
      default: 'active',
      required: true,
    },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
    // Atomically incremented (Phase 19) to hand out unique, strictly
    // increasing waitlist queue positions per book without a read-then-
    // write race. Monotonic only — gaps from cancelled entries are fine,
    // since only relative order matters, not contiguity.
    waitlistCounter: { type: Number, default: 0 },
  },
  { timestamps: true }
);

bookSchema.index({ genre: 1 });
bookSchema.index({ author: 1 });
bookSchema.index({ status: 1 });

module.exports = mongoose.model('Book', bookSchema);
