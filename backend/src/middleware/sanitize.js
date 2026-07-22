const mongoSanitize = require('express-mongo-sanitize');
const sanitizeHtmlLib = require('sanitize-html');

// Strips $ and . prefixed keys from req.body/query/params, so a payload
// like { "$gt": "" } submitted as a field value can't be interpreted as a
// MongoDB query operator by a later findOne()/find() call built from that
// same input. Must be registered before any route that touches user input
// — see the comment above its mount point in app.js for why the exact
// registration order matters.
const sanitizeInput = mongoSanitize();

/**
 * Sanitizes free-text user input intended for storage (Book.description,
 * Loan.memberNote, Loan.librarianNote) — sanitize on write, so whatever
 * ends up in MongoDB is already clean regardless of which client wrote it,
 * rather than relying on every future render path to escape it correctly.
 *
 * Called explicitly at each field's write site (not via a blanket Mongoose
 * pre('save') hook), so every write path has to deliberately opt in —
 * that's a conscious tradeoff: a model-level hook would be harder to
 * accidentally skip, but this app has more than one handler that can write
 * these fields (e.g. loan creation vs. loan note edits), and each one
 * needs to be independently verifiable as sanitizing correctly.
 *
 * Strips all HTML outright — none of these fields have a legitimate use
 * for rich text, so an allow-nothing policy is simpler and safer than
 * maintaining an allow-list of "safe" tags.
 */
function sanitizeHtml(input) {
  if (typeof input !== 'string') {
    return input;
  }
  return sanitizeHtmlLib(input, {
    allowedTags: [],
    allowedAttributes: {},
  });
}

module.exports = { sanitizeInput, sanitizeHtml };
