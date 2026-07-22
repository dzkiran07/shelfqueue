const Waitlist = require('../models/Waitlist');
const Book = require('../models/Book');
const User = require('../models/User');
const env = require('../config/env');
const { logActivity } = require('../middleware/auditLogger');
const emailService = require('./emailService');
const logger = require('../utils/logger');

/**
 * Copy-accounting model for the waitlist:
 *
 * A copy that frees up (a loan returned, or a 'requested' loan cancelled/
 * rejected before checkout) is handled EXCLUSIVELY through this function —
 * nothing else increments Book.copiesAvailable while a waitlist could be
 * involved. That's deliberate: if the freed copy were added back to
 * copiesAvailable immediately, a totally unrelated direct loan request
 * (POST /api/loans, Phase 18's atomic claim) could win it before the
 * waitlisted member ever got a chance — silently defeating the entire
 * point of an "ordered" queue. So:
 *
 *   - If someone is waiting: the copy is handed to them via an 'offered'
 *     Waitlist entry (with a claim window) and Book.copiesAvailable is
 *     NOT touched — the copy stays off the general market, reserved for
 *     that specific member until they claim it or the offer expires.
 *   - If nobody is waiting: only then does the copy genuinely return to
 *     the general pool (copiesAvailable += 1).
 *
 * This also means POST /api/waitlist/:id/claim never needs to decrement
 * copiesAvailable itself — the copy was never added back to begin with.
 */
async function offerNextInQueue(bookId) {
  const offerExpiresAt = new Date(Date.now() + env.WAITLIST_OFFER_HOURS * 60 * 60 * 1000);

  // Atomic: filter + sort + update happen as one operation, so this always
  // targets the single earliest 'waiting' entry for this book, and two
  // near-simultaneous calls (e.g. a return racing a sweep) can't both
  // grab the same entry.
  const offeredEntry = await Waitlist.findOneAndUpdate(
    { bookId, status: 'waiting' },
    { status: 'offered', offeredAt: new Date(), offerExpiresAt },
    { sort: { queuePosition: 1 }, new: true }
  );

  if (offeredEntry) {
    // No `req` here — this fires from several different call sites
    // (cancel, reject, mark-returned, mark-damaged, leave-waitlist, and
    // the expiry sweep), several of which have no HTTP request in scope
    // at all (the sweep runs on a timer). actorId is left unset for the
    // same reason: the actual triggering actor (if any) is already
    // captured in the caller's OWN audit entry for that action.
    await logActivity({
      action: 'waitlist_offered',
      resourceType: 'Waitlist',
      resourceId: offeredEntry._id,
      metadata: { bookId, memberId: offeredEntry.memberId },
    });

    try {
      const [member, book] = await Promise.all([
        User.findById(offeredEntry.memberId).select('email notificationPreferences'),
        Book.findById(bookId).select('title'),
      ]);
      if (member?.notificationPreferences?.email && book) {
        await emailService.sendWaitlistOfferEmail(member.email, {
          bookTitle: book.title,
          expiresAt: offerExpiresAt,
        });
      }
    } catch (err) {
      // Same rule as password-reset emails: a notification failing to send
      // must never break the underlying state transition it's attached to.
      logger.error(`Failed to send waitlist offer email: ${err.message}`);
    }

    return { offered: offeredEntry };
  }

  // Nobody in line for this title — the copy genuinely goes back on the
  // shelf, so to speak.
  await Book.findByIdAndUpdate(bookId, { $inc: { copiesAvailable: 1 } });
  return { offered: null };
}

/**
 * Sweeps 'offered' entries whose claim window has passed: marks each
 * 'expired' and passes the copy along to the next person in that book's
 * queue (or back to the general pool if the queue is now empty) via
 * offerNextInQueue — exactly as if the member had voluntarily given up
 * the offer.
 */
async function sweepExpiredOffers() {
  const now = new Date();
  const candidates = await Waitlist.find({ status: 'offered', offerExpiresAt: { $lt: now } });

  const results = [];
  for (const candidate of candidates) {
    // Re-check atomically at the moment of the update, not just at the
    // moment of the find above — a claim request could have landed in
    // between (or a previous sweep iteration could have already handled
    // it), so only proceed if this entry is still genuinely expired.
    // eslint-disable-next-line no-await-in-loop
    const expired = await Waitlist.findOneAndUpdate(
      { _id: candidate._id, status: 'offered', offerExpiresAt: { $lt: now } },
      { status: 'expired' },
      { new: true }
    );

    if (expired) {
      // eslint-disable-next-line no-await-in-loop
      await logActivity({
        action: 'waitlist_expired',
        resourceType: 'Waitlist',
        resourceId: expired._id,
        metadata: { bookId: expired.bookId, memberId: expired.memberId },
      });
      // eslint-disable-next-line no-await-in-loop
      await offerNextInQueue(expired.bookId);
      results.push(expired._id);
    }
  }

  return results;
}

module.exports = { offerNextInQueue, sweepExpiredOffers };
