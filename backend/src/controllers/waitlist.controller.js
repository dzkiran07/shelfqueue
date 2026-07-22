const mongoose = require('mongoose');
const Book = require('../models/Book');
const Loan = require('../models/Loan');
const Waitlist = require('../models/Waitlist');
const waitlistService = require('../services/waitlistService');
const { logActivity } = require('../middleware/auditLogger');

async function joinWaitlist(req, res, next) {
  try {
    const { bookId } = req.body || {};

    if (!bookId || !mongoose.Types.ObjectId.isValid(bookId)) {
      return res.status(400).json({ error: 'A valid bookId is required' });
    }

    const book = await Book.findById(bookId);
    if (!book || book.status !== 'active') {
      return res.status(404).json({ error: 'Book not found' });
    }

    if (book.copiesAvailable > 0) {
      return res.status(400).json({
        error: 'Copies are currently available — request a loan directly instead of joining the waitlist',
      });
    }

    // Atomically claim the next sequential position for this book, rather
    // than reading the current max and writing max+1 — two concurrent
    // joins doing a plain read-then-write could otherwise land on the
    // same position.
    const updatedBook = await Book.findByIdAndUpdate(
      bookId,
      { $inc: { waitlistCounter: 1 } },
      { new: true }
    );

    try {
      const entry = await Waitlist.create({
        bookId,
        memberId: req.user._id,
        queuePosition: updatedBook.waitlistCounter,
        status: 'waiting',
      });

      await logActivity({
        actorId: req.user._id,
        action: 'waitlist_joined',
        resourceType: 'Waitlist',
        resourceId: entry._id,
        req,
        metadata: { bookId },
      });

      return res.status(201).json({ waitlistEntry: entry });
    } catch (err) {
      if (err.code === 11000) {
        // Caught by the partial unique index (bookId+memberId while
        // status:'waiting') — this member already has an active entry
        // for this book.
        return res.status(409).json({ error: 'You are already on the waitlist for this title' });
      }
      throw err;
    }
  } catch (err) {
    return next(err);
  }
}

async function getMyWaitlist(req, res, next) {
  try {
    const entries = await Waitlist.find({ memberId: req.user._id })
      .sort({ createdAt: -1 })
      .populate('bookId', 'title author coverUrl');

    return res.status(200).json({ waitlist: entries });
  } catch (err) {
    return next(err);
  }
}

/**
 * Converts an 'offered' entry into a real Loan. The ownership check
 * (memberId must match the caller) is folded directly into the same
 * atomic findOneAndUpdate as the status/expiry check, rather than done as
 * a separate lookup first — two claim requests racing for the same offer
 * (e.g. the same member double-clicking, or a forged request) can't both
 * pass a check-then-act sequence and both succeed; only one findOneAndUpdate
 * can match status:'offered' and flip it.
 */
async function claimWaitlistOffer(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid waitlist entry id' });
    }

    const entry = await Waitlist.findOneAndUpdate(
      {
        _id: id,
        memberId: req.user._id,
        status: 'offered',
        offerExpiresAt: { $gt: new Date() },
      },
      { status: 'fulfilled' },
      { new: true }
    );

    if (!entry) {
      // Not yours, not currently offered, already claimed, or expired —
      // one generic response for all of them so as not to confirm which.
      return res.status(404).json({ error: 'No claimable offer found' });
    }

    // copiesAvailable is deliberately NOT touched here — see
    // waitlistService.offerNextInQueue's doc comment. The copy has been
    // reserved-but-not-claimed since the offer was made; claiming it just
    // converts that reservation into a real loan request.
    const loan = await Loan.create({
      bookId: entry.bookId,
      memberId: entry.memberId,
      status: 'requested',
      requestedAt: new Date(),
    });

    await logActivity({
      actorId: req.user._id,
      action: 'waitlist_claimed',
      resourceType: 'Waitlist',
      resourceId: entry._id,
      req,
      metadata: { bookId: entry.bookId, loanId: loan._id },
    });

    return res.status(201).json({ loan });
  } catch (err) {
    return next(err);
  }
}

async function leaveWaitlist(req, res, next) {
  try {
    const entry = req.resource;

    if (!['waiting', 'offered'].includes(entry.status)) {
      return res.status(400).json({ error: 'This waitlist entry is no longer active' });
    }

    const wasOffered = entry.status === 'offered';
    entry.status = 'cancelled';
    await entry.save();

    if (wasOffered) {
      // Voluntarily giving up an active offer — pass it to the next
      // person in line immediately rather than leaving the copy in limbo
      // until the offer would otherwise have naturally expired.
      await waitlistService.offerNextInQueue(entry.bookId);
    }

    return res.status(200).json({ status: 'left waitlist' });
  } catch (err) {
    return next(err);
  }
}

// Librarian-facing view of a single book's live queue (waiting + offered
// entries only — fulfilled/expired/cancelled ones are history, not a queue
// to manage).
async function adminListForBook(req, res, next) {
  try {
    const { bookId } = req.query;
    if (!bookId || !mongoose.Types.ObjectId.isValid(bookId)) {
      return res.status(400).json({ error: 'A valid bookId is required' });
    }

    const entries = await Waitlist.find({ bookId, status: { $in: ['waiting', 'offered'] } })
      .sort({ queuePosition: 1 })
      .populate('memberId', 'name email')
      .populate('bookId', 'title author copiesAvailable');

    return res.status(200).json({ waitlist: entries });
  } catch (err) {
    return next(err);
  }
}

/**
 * Manual escape hatch for offerNextInQueue (see its doc comment in
 * waitlistService.js for the full copy-accounting model). Intended for a
 * copy that became available through some path other than the normal
 * loan-return/cancel/reject transitions — e.g. a librarian correcting
 * copiesAvailable directly in the catalog manager — so the queue can still
 * be honored instead of that copy silently going straight to whoever
 * requests a loan next.
 */
async function adminOfferNext(req, res, next) {
  try {
    const { bookId } = req.body || {};
    if (!bookId || !mongoose.Types.ObjectId.isValid(bookId)) {
      return res.status(400).json({ error: 'A valid bookId is required' });
    }

    const book = await Book.findById(bookId);
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const result = await waitlistService.offerNextInQueue(bookId);

    await logActivity({
      actorId: req.user._id,
      action: 'waitlist_manual_offer',
      resourceType: 'Waitlist',
      resourceId: result.offered?._id,
      req,
      metadata: { bookId },
    });

    return res.status(200).json({ offered: result.offered });
  } catch (err) {
    return next(err);
  }
}

/**
 * Librarian-initiated version of leaveWaitlist — same transition, but not
 * scoped to the entry's own owner (e.g. a member who's unreachable and
 * needs to be skipped by staff). Passes the copy to the next person in line
 * if the skipped entry currently held an active offer.
 */
async function adminSkipEntry(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: 'Invalid waitlist entry id' });
    }

    const entry = await Waitlist.findById(id);
    if (!entry) {
      return res.status(404).json({ error: 'Waitlist entry not found' });
    }
    if (!['waiting', 'offered'].includes(entry.status)) {
      return res.status(400).json({ error: 'This waitlist entry is no longer active' });
    }

    const wasOffered = entry.status === 'offered';
    entry.status = 'cancelled';
    await entry.save();

    if (wasOffered) {
      await waitlistService.offerNextInQueue(entry.bookId);
    }

    await logActivity({
      actorId: req.user._id,
      action: 'waitlist_manual_skip',
      resourceType: 'Waitlist',
      resourceId: entry._id,
      req,
      metadata: { bookId: entry.bookId, memberId: entry.memberId },
    });

    return res.status(200).json({ waitlistEntry: entry });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  joinWaitlist,
  getMyWaitlist,
  claimWaitlistOffer,
  leaveWaitlist,
  adminListForBook,
  adminOfferNext,
  adminSkipEntry,
};
