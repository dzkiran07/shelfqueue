const tokenService = require('../services/tokenService');
const User = require('../models/User');

/**
 * Verifies the access-token cookie and re-fetches the user's current role
 * and status from MongoDB on every request, rather than trusting only the
 * JWT payload (which deliberately carries nothing but the user id — see
 * tokenService.signAccessToken). This is the zero-trust boundary: a role
 * change or account suspension takes effect on the very next request,
 * instead of waiting up to 15 days for the access token to expire.
 */
async function requireAuth(req, res, next) {
  try {
    const token = req.cookies?.[tokenService.ACCESS_TOKEN_COOKIE];
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let payload;
    try {
      payload = tokenService.verifyAccessToken(token);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    const user = await User.findById(payload.sub);
    if (!user || user.status === 'suspended') {
      return res.status(401).json({ error: 'Invalid or expired session' });
    }

    req.user = user;
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAuth };
