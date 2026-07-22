/**
 * Role-checking middleware factory. Must run after requireAuth (middleware/
 * auth.js), which attaches the authenticated user — re-fetched fresh from
 * MongoDB on this same request — to req.user. requireRole never re-derives
 * or re-trusts a role from anywhere else (a JWT claim, a request body/query
 * param); it only ever reads the role requireAuth just looked up, so a
 * client can't influence its own authorization by sending a role field.
 */
function requireRole(...roles) {
  return function roleCheck(req, res, next) {
    if (!req.user) {
      // Misconfiguration guard: requireRole was mounted without requireAuth
      // running first, so there's nothing to check a role against.
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    return next();
  };
}

module.exports = { requireRole };
