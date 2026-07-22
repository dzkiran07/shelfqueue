const env = require('../config/env');

// hCaptcha's siteverify contract (secret/response/remoteip in, {success}
// JSON out) is effectively identical to reCAPTCHA v2's — swapping providers
// later would only mean changing this URL.
const VERIFY_URL = 'https://hcaptcha.com/siteverify';

/**
 * Server-side CAPTCHA verification. The client-side widget alone proves
 * nothing — it can be scripted around entirely — so every token gets
 * checked against the provider's own siteverify endpoint before we trust it.
 */
async function verifyCaptcha(token, remoteIp) {
  if (!token) {
    return false;
  }

  const params = new URLSearchParams();
  params.set('secret', env.CAPTCHA_SECRET || '');
  params.set('response', token);
  if (remoteIp) {
    params.set('remoteip', remoteIp);
  }

  try {
    const response = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params,
    });
    const data = await response.json();
    return Boolean(data.success);
  } catch (err) {
    // Provider unreachable/timed out — fail closed. A network blip should
    // never silently disable the check it's supposed to enforce.
    return false;
  }
}

/**
 * Express middleware: rejects the request unless req.body.captchaToken
 * verifies successfully. Skipped only under NODE_ENV=test, so automated
 * test suites aren't stuck making real network calls to a third-party
 * service (or blocked entirely without live credentials) — that bypass is
 * gated purely on server-side config, never on anything the client sends.
 */
async function requireCaptcha(req, res, next) {
  if (env.NODE_ENV === 'test') {
    return next();
  }

  const { captchaToken } = req.body || {};
  if (!captchaToken) {
    return res.status(400).json({ error: 'CAPTCHA verification is required' });
  }

  const passed = await verifyCaptcha(captchaToken, req.ip);
  if (!passed) {
    return res.status(400).json({ error: 'CAPTCHA verification failed' });
  }

  return next();
}

module.exports = { verifyCaptcha, requireCaptcha };
