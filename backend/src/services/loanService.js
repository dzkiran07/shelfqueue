const Loan = require('../models/Loan');
const AuditLog = require('../models/AuditLog');
const Book = require('../models/Book');
const User = require('../models/User');
const emailService = require('./emailService');
const logger = require('../utils/logger');

/**
 * Sweeps 'checked_out' loans past their dueDate and flips them to
 * 'overdue', writing an audit log entry for each. actorId is deliberately
 * left unset on these entries — this is a system/automated transition, not
 * something a user or librarian did, and AuditLog.actorId isn't required
 * for exactly this reason.
 */
async function sweepOverdueLoans() {
  const now = new Date();
  const candidates = await Loan.find({ status: 'checked_out', dueDate: { $lt: now } });

  const results = [];
  for (const candidate of candidates) {
    // Atomic re-check at the moment of update, not just at the moment of
    // the find above — guards against this same loan being handled twice
    // if a sweep somehow overlapped with itself or with a concurrent
    // librarian action on the same loan.
    // eslint-disable-next-line no-await-in-loop
    const overdueLoan = await Loan.findOneAndUpdate(
      { _id: candidate._id, status: 'checked_out', dueDate: { $lt: now } },
      { status: 'overdue' },
      { new: true }
    );

    if (overdueLoan) {
      // eslint-disable-next-line no-await-in-loop
      await AuditLog.create({
        action: 'loan_overdue',
        resourceType: 'Loan',
        resourceId: overdueLoan._id,
        metadata: { bookId: overdueLoan.bookId, memberId: overdueLoan.memberId, dueDate: overdueLoan.dueDate },
      });

      try {
        // eslint-disable-next-line no-await-in-loop
        const [member, book] = await Promise.all([
          User.findById(overdueLoan.memberId).select('email notificationPreferences'),
          Book.findById(overdueLoan.bookId).select('title'),
        ]);
        if (member?.notificationPreferences?.email && book) {
          // eslint-disable-next-line no-await-in-loop
          await emailService.sendLoanOverdueEmail(member.email, {
            bookTitle: book.title,
            dueDate: overdueLoan.dueDate,
          });
        }
      } catch (err) {
        // A notification failing to send must never break the sweep's
        // actual job of flipping the loan's status.
        logger.error(`Failed to send loan overdue email: ${err.message}`);
      }

      results.push(overdueLoan._id);
    }
  }

  return results;
}

module.exports = { sweepOverdueLoans };
