const express = require('express');
const authController = require('../controllers/auth.controller');
const { strictAuthLimiter } = require('../middleware/rateLimit');
const { requireAuth } = require('../middleware/auth');
const { requireCaptcha } = require('../services/captchaService');
const passport = require('../services/oauthService');
const emailService = require('../services/emailService');
const env = require('../config/env');

const router = express.Router();

router.post('/password-strength', authController.passwordStrengthCheck);

router.post('/register', strictAuthLimiter, requireCaptcha, authController.register);
router.post('/login', strictAuthLimiter, requireCaptcha, authController.login);
router.post('/refresh', authController.refresh);
router.post('/logout', authController.logout);
router.get('/me', requireAuth, authController.getCurrentUser);

router.post('/forgot-password', strictAuthLimiter, authController.forgotPassword);
router.post('/reset-password/:token', strictAuthLimiter, authController.resetPassword);

router.post('/mfa/setup', requireAuth, authController.mfaSetup);
router.post('/mfa/verify-setup', strictAuthLimiter, requireAuth, authController.mfaVerifySetup);
router.post('/mfa/challenge', strictAuthLimiter, authController.mfaChallenge);

router.post('/webauthn/register-options', requireAuth, authController.webauthnRegisterOptions);
router.post(
  '/webauthn/register-verify',
  strictAuthLimiter,
  requireAuth,
  authController.webauthnRegisterVerify
);
router.post('/webauthn/login-options', strictAuthLimiter, authController.webauthnLoginOptions);
router.post('/webauthn/login-verify', strictAuthLimiter, authController.webauthnLoginVerify);

router.get('/sessions', requireAuth, authController.listSessions);
router.delete('/sessions/:id', requireAuth, authController.revokeSessionById);

router.get('/google', authController.googleLoginStart);
router.get('/google/link', requireAuth, authController.googleLinkStart);
router.get(
  '/google/callback',
  passport.authenticate('google', {
    session: false,
    failureRedirect: `${env.FRONTEND_ORIGIN}/login?oauthError=oauth_failed`,
  }),
  authController.googleCallback
);

// Dev/demo-only: surfaces the most recent Ethereal preview URL so a
// password reset email can actually be seen and clicked without a real
// inbox — Ethereal never delivers anywhere real. Never mounted in
// production, since it would otherwise expose whatever the last sent
// email's content was to any caller.
if (env.NODE_ENV !== 'production') {
  router.get('/debug/last-email-preview', (req, res) => {
    res.status(200).json({ previewUrl: emailService.getLastPreviewUrl() });
  });
}

module.exports = router;
