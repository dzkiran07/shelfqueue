/**
 * Resource-level ownership middleware factory. Must run after requireAuth,
 * which attaches req.user. Fetches the resource by :id, then allows the
 * request through only if the requester owns it (req.user._id matches
 * resource[ownerField]) or is a librarian — librarians aren't special-cased
 * around security, only around permissions, per the app's design.
 *
 * Returns 404 rather than 403 for both "doesn't exist" and "exists but
 * isn't yours": a 403 would itself leak that the resource exists, which is
 * exactly the kind of information an IDOR probe is fishing for.
 */
function requireOwnership(resourceModel, resourceIdParam, ownerField) {
  return async function ownershipCheck(req, res, next) {
    try {
      const resourceId = req.params[resourceIdParam];
      const resource = await resourceModel.findById(resourceId);

      if (!resource) {
        return res.status(404).json({ error: 'Not found' });
      }

      const isOwner = String(resource[ownerField]) === String(req.user._id);
      const isLibrarian = req.user.role === 'librarian';

      if (!isOwner && !isLibrarian) {
        return res.status(404).json({ error: 'Not found' });
      }

      req.resource = resource;
      return next();
    } catch (err) {
      // A malformed :id (not a valid ObjectId) throws a Mongoose CastError
      // — treat it identically to "not found" rather than leaking that the
      // ID's format specifically was the problem.
      if (err.name === 'CastError') {
        return res.status(404).json({ error: 'Not found' });
      }
      return next(err);
    }
  };
}

module.exports = { requireOwnership };
