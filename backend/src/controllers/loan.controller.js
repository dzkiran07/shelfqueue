// Loan lifecycle handlers: member-facing (create/view/edit-note/cancel) and
// the librarian-only admin state machine (Phase 20).

const mongoose = require('mongoose');
const Book = require('../models/Book');
const Loan = require('../models/Loan');
const { sanitizeHtml } = require('../middleware/sanitize');
const waitlistService = require('../services/waitlistService');
const env = require('../config/env');
const { logActivity } = require('../middleware/auditLogger');

async function getLoan(req, res) {
  return res.status(200).json({ loan: req.resource });
}

async function getMyLoans(req, res, next) {
  try {
    const loans = await Loan.find({ memberId: req.user._id })
      .sort({ requestedAt: -1 })
      .populate('bookId', 'title author coverUrl');

    return res.status(200).json({ loans });
  } catch (err) {
    return next(err);
  }
}

const LOAN_STATUSES = [
  'requested',
  'approved',
  'rejected',
  'checked_out',
  'returned',
  'overdue',
  'lost',
  'damaged',
  'cancelled',
];
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

// Librarian-facing listing across every member's loans — powers both the
// dashboard's summary counts (called with a status filter and limit=1, just
// to read pagination.total) and the loan approvals queue.
async function adminListLoans(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(
      Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_LIMIT, 1),
      MAX_PAGE_LIMIT
    );

    const filter = {};
    if (typeof req.query.status === 'string' && req.query.status.trim()) {
      const statuses = req.query.status
        .split(',')
        .map((s) => s.trim())
        .filter((s) => LOAN_STATUSES.includes(s));
      if (statuses.length > 0) {
        filter.status = { $in: statuses };
      }
    }

    const [loans, total] = await Promise.all([
      Loan.find(filter)
        .sort({ requestedAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate('bookId', 'title author')
        .populate('memberId', 'name email'),
      Loan.countDocuments(filter),
    ]);

    return res.status(200).json({
      loans,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return next(err);
  }
}

async function updateLoan(req, res, next) {
  try {
    const { memberNote } = req.body || {};

    // Explicit allow-list of exactly one field. status is deliberately
    // never accepted here — status changes only ever happen through the
    // dedicated admin transition endpoints below or cancelLoan, never
    // through this general-purpose update route.
    if (memberNote !== undefined) {
      // Sanitized on write so stored data is clean regardless of client.
      req.resource.memberNote = sanitizeHtml(memberNote);
    }

    await req.resource.save();
    return res.status(200).json({ loan: req.resource });
  } catch (err) {
    return next(err);
  }
}

/**
 * Member-only cancel, restricted to loans still in 'requested' status —
 * that's the only status where a copy was atomically claimed (Phase 18)
 * without yet being physically handed over, so it's the only status where
 * a member unilaterally backing out makes sense. This is a soft transition
 * to 'cancelled' (not a hard delete) so the request stays in the loan
 * history — and it deliberately never shares a code path with updateLoan
 * above or the librarian transition endpoints below.
 */
async function cancelLoan(req, res, next) {
  try {
    if (req.resource.status !== 'requested') {
      return res
        .status(400)
        .json({ error: 'Only a loan still in "requested" status can be cancelled this way' });
    }

    req.resource.status = 'cancelled';
    req.resource.decidedBy = req.user._id;
    req.resource.decidedAt = new Date();
    await req.resource.save();

    // The copy claimed atomically at request time (Phase 18) needs to be
    // released now that the request is being withdrawn.
    await waitlistService.offerNextInQueue(req.resource.bookId);

    await logActivity({
      actorId: req.user._id,
      action: 'loan_cancelled',
      resourceType: 'Loan',
      resourceId: req.resource._id,
      req,
    });

    return res.status(200).json({ loan: req.resource });
  } catch (err) {
    return next(err);
  }
}

/**
 * Claims a copy and creates a loan request. The availability check and the
 * decrement happen as a single atomic findOneAndUpdate rather than a
 * multi-document transaction: this is fundamentally a single-document
 * invariant (Book.copiesAvailable > 0), and MongoDB guarantees only one
 * concurrent findOneAndUpdate call can match-and-modify a given document
 * for a given filter — so two requests racing for the last copy can't both
 * observe "1 available" and both decrement. A transaction would work too,
 * but would also require MongoDB to run as a replica set purely to protect
 * one field on one document, which this app's deployment doesn't need
 * otherwise.
 */
async function createLoan(req, res, next) {
  try {
    const { bookId, memberNote } = req.body || {};

    if (!bookId || !mongoose.Types.ObjectId.isValid(bookId)) {
      return res.status(400).json({ error: 'A valid bookId is required' });
    }

    const claimedBook = await Book.findOneAndUpdate(
      { _id: bookId, status: 'active', copiesAvailable: { $gt: 0 } },
      { $inc: { copiesAvailable: -1 } },
      { new: true }
    );

    if (!claimedBook) {
      const book = await Book.findById(bookId);

      if (!book) {
        return res.status(404).json({ error: 'Book not found' });
      }
      if (book.status !== 'active') {
        return res.status(400).json({ error: 'This title is not available for loan' });
      }

      // Book exists and is active, so the claim failed purely because
      // copiesAvailable was already 0 — direct the client to the waitlist
      // instead.
      return res.status(409).json({
        error: 'No copies available for this title',
        joinWaitlist: true,
        bookId: book._id,
      });
    }

    try {
      // dueDate is deliberately left unset here — it's computed once the
      // loan is approved (see approve() below), not at request time, since
      // a 'requested' loan isn't yet a guarantee the loan will be granted.
      const loan = await Loan.create({
        bookId: claimedBook._id,
        memberId: req.user._id,
        status: 'requested',
        requestedAt: new Date(),
        memberNote: memberNote !== undefined ? sanitizeHtml(memberNote) : undefined,
      });

      await logActivity({
        actorId: req.user._id,
        action: 'loan_requested',
        resourceType: 'Loan',
        resourceId: loan._id,
        req,
      });

      return res.status(201).json({ loan });
    } catch (err) {
      // The copy was already atomically claimed above; if creating the
      // loan record itself then fails, release that claim rather than
      // leaving copiesAvailable permanently short by one with no loan to
      // show for it. There's no surrounding transaction here to roll this
      // back automatically, so this compensating update does it
      // explicitly.
      await Book.findByIdAndUpdate(claimedBook._id, { $inc: { copiesAvailable: 1 } });
      throw err;
    }
  } catch (err) {
    return next(err);
  }
}

// --- Librarian-only admin state machine -----------------------------------
//
// Each action is only valid from a specific set of current statuses; the
// from-status check and the transition itself happen as a single atomic
// findOneAndUpdate, so two librarians (or a double-click) racing to apply
// conflicting actions to the same loan can't both succeed — the loser gets
// a 409, not a corrupted state.
//
// 'reject', 'markReturned', and 'markDamaged' release the claimed copy via
// waitlistService.offerNextInQueue — NOT a separate unconditional
// Book.copiesAvailable increment. offerNextInQueue is the sole authority
// over copiesAvailable (see its doc comment in waitlistService.js):
// incrementing it here directly, in addition to also notifying the
// waitlist, would let a copy be simultaneously "available" for a direct
// loan request AND "offered" to a queued member — exactly the race Phase
// 19 was built to prevent. 'markLost' does NOT release the copy: the book
// isn't coming back, so it was never available to release.
const RELEASES_COPY = new Set(['reject', 'markReturned', 'markDamaged']);

const TRANSITIONS = {
  approve: {
    from: ['requested'],
    to: 'approved',
    // "14 days from approval" (per the member workflow) — anchored to the
    // approval timestamp itself, not the original request time, so a
    // request that sits pending for a while doesn't eat into the
    // member's actual borrowing window.
    extraFields: (now) => ({
      dueDate: new Date(now.getTime() + env.LOAN_PERIOD_DAYS * 24 * 60 * 60 * 1000),
    }),
  },
  reject: { from: ['requested'], to: 'rejected' },
  markCheckedOut: { from: ['approved'], to: 'checked_out', extraFields: (now) => ({ checkedOutAt: now }) },
  markReturned: { from: ['checked_out', 'overdue'], to: 'returned', extraFields: (now) => ({ returnedAt: now }) },
  markLost: { from: ['checked_out', 'overdue'], to: 'lost' },
  markDamaged: { from: ['checked_out', 'overdue'], to: 'damaged', extraFields: (now) => ({ returnedAt: now }) },
};

function createTransitionHandler(action) {
  const { from, to, extraFields } = TRANSITIONS[action];

  return async function transitionHandler(req, res, next) {
    try {
      const { id } = req.params;
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(400).json({ error: 'Invalid loan id' });
      }

      const now = new Date();
      const setFields = {
        status: to,
        decidedBy: req.user._id,
        decidedAt: now,
        ...(extraFields ? extraFields(now) : {}),
      };

      if (action === 'markReturned' || action === 'markDamaged') {
        const { conditionOnReturn } = req.body || {};
        if (conditionOnReturn !== undefined) {
          setFields.conditionOnReturn = sanitizeHtml(conditionOnReturn);
        }
      }

      const loan = await Loan.findOneAndUpdate(
        { _id: id, status: { $in: from } },
        { $set: setFields },
        { new: true }
      );

      if (!loan) {
        const existing = await Loan.findById(id);
        if (!existing) {
          return res.status(404).json({ error: 'Loan not found' });
        }
        return res.status(409).json({
          error: `Cannot apply "${action}" to a loan currently in "${existing.status}" status`,
        });
      }

      if (RELEASES_COPY.has(action)) {
        await waitlistService.offerNextInQueue(loan.bookId);
      }

      await logActivity({
        actorId: req.user._id,
        action: `loan_${action}`,
        resourceType: 'Loan',
        resourceId: loan._id,
        req,
        metadata: { fromStatuses: from, toStatus: to },
      });

      return res.status(200).json({ loan });
    } catch (err) {
      return next(err);
    }
  };
}

const approve = createTransitionHandler('approve');
const reject = createTransitionHandler('reject');
const markCheckedOut = createTransitionHandler('markCheckedOut');
const markReturned = createTransitionHandler('markReturned');
const markLost = createTransitionHandler('markLost');
const markDamaged = createTransitionHandler('markDamaged');

module.exports = {
  getLoan,
  getMyLoans,
  adminListLoans,
  updateLoan,
  cancelLoan,
  createLoan,
  approve,
  reject,
  markCheckedOut,
  markReturned,
  markLost,
  markDamaged,
};
