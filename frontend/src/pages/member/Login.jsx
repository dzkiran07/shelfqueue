import { useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams, Link } from 'react-router-dom';
import HCaptcha from '@hcaptcha/react-hcaptcha';
import { useAuth } from '../../context/AuthContext.jsx';
import { GoogleIcon, KeyIcon } from '../../components/ui/icons.jsx';

const CAPTCHA_SITE_KEY = import.meta.env.VITE_CAPTCHA_SITE_KEY;
const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

const OAUTH_ERROR_MESSAGES = {
  no_email: 'Your Google account has no email address associated with it.',
  email_registered:
    'An account with this email already exists. Log in with your password, then connect Google from Settings.',
  suspended: 'This account has been suspended.',
  oauth_failed: 'Google sign-in failed. Please try again.',
  already_linked_elsewhere: 'That Google account is already linked to a different ShelfQueue account.',
};

export default function Login() {
  const { login, completeMfaChallenge, loginWithPasskey } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const captchaRef = useRef(null);

  const [email, setEmail] = useState(location.state?.email || '');
  const [password, setPassword] = useState('');
  const [captchaToken, setCaptchaToken] = useState(null);
  const [error, setError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [passkeyPending, setPasskeyPending] = useState(false);

  // Set once password/passkey login returns mfaRequired — from that point
  // on the form shows the MFA code step instead of the credentials step.
  const [mfaPendingToken, setMfaPendingToken] = useState(null);
  const [mfaCode, setMfaCode] = useState('');

  const oauthError = searchParams.get('oauthError');
  const justRegistered = location.state?.registered;
  const justResetPassword = location.state?.passwordReset;

  function goToDestination() {
    const redirectTo = location.state?.from?.pathname || '/';
    navigate(redirectTo, { replace: true });
  }

  async function handlePasswordLogin(e) {
    e.preventDefault();
    setError(null);

    if (!captchaToken) {
      setError('Please complete the CAPTCHA');
      return;
    }

    setSubmitting(true);
    try {
      const result = await login(email, password, captchaToken);
      if (result.mfaRequired) {
        setMfaPendingToken(result.mfaPendingToken);
      } else {
        goToDestination();
      }
    } catch (err) {
      const data = err.response?.data;
      if (data?.passwordExpired) {
        navigate('/forgot-password', { state: { email, passwordExpired: true } });
        return;
      }
      setError(data?.error || 'Login failed. Please try again.');
      captchaRef.current?.resetCaptcha();
      setCaptchaToken(null);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleMfaSubmit(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await completeMfaChallenge(mfaPendingToken, mfaCode);
      goToDestination();
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid verification code');
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePasskeyLogin() {
    setError(null);
    if (!email) {
      setError('Enter your email first, then choose "Sign in with a passkey"');
      return;
    }

    setPasskeyPending(true);
    try {
      const result = await loginWithPasskey(email);
      if (result.mfaRequired) {
        setMfaPendingToken(result.mfaPendingToken);
      } else {
        goToDestination();
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Passkey sign-in failed. Please try again.');
    } finally {
      setPasskeyPending(false);
    }
  }

  function handleGoogleLogin() {
    window.location.href = `${API_BASE_URL}/api/auth/google`;
  }

  if (mfaPendingToken) {
    return (
      <div>
        <h1>Two-factor verification</h1>
        {error ? (
          <div role="alert" id="mfa-error">
            {error}
          </div>
        ) : null}
        <form onSubmit={handleMfaSubmit} noValidate>
          <div>
            <label htmlFor="mfa-code">Authenticator code</label>
            <input
              id="mfa-code"
              name="mfaCode"
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
              value={mfaCode}
              onChange={(e) => setMfaCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              aria-describedby={error ? 'mfa-error' : undefined}
            />
          </div>
          <button type="submit" disabled={submitting}>
            {submitting ? 'Verifying…' : 'Verify'}
          </button>
        </form>
      </div>
    );
  }

  return (
    <div>
      <h1>Log in</h1>

      {justRegistered ? <p role="status">Registration successful. Please log in.</p> : null}
      {justResetPassword ? <p role="status">Password reset successful. Please log in.</p> : null}
      {oauthError ? (
        <div role="alert">{OAUTH_ERROR_MESSAGES[oauthError] || 'Google sign-in failed.'}</div>
      ) : null}
      {error ? (
        <div role="alert" id="login-error">
          {error}
        </div>
      ) : null}

      <form onSubmit={handlePasswordLogin} noValidate>
        <div>
          <label htmlFor="login-email">Email</label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={error ? 'login-error' : undefined}
          />
        </div>

        <div>
          <label htmlFor="login-password">Password</label>
          <input
            id="login-password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby={error ? 'login-error' : undefined}
          />
        </div>

        <HCaptcha
          ref={captchaRef}
          sitekey={CAPTCHA_SITE_KEY}
          onVerify={(token) => setCaptchaToken(token)}
          onExpire={() => setCaptchaToken(null)}
        />

        <button type="submit" disabled={submitting}>
          {submitting ? 'Logging in…' : 'Log in'}
        </button>
      </form>

      <div className="oauth-row">
        <button type="button" className="oauth-button" onClick={handlePasskeyLogin} disabled={passkeyPending}>
          <KeyIcon />
          {passkeyPending ? 'Waiting…' : 'Passkey'}
        </button>

        <button type="button" className="oauth-button" onClick={handleGoogleLogin}>
          <GoogleIcon />
          Google
        </button>
      </div>

      <p>
        <Link to="/forgot-password">Forgot password?</Link>
      </p>
      <p>
        Need an account? <Link to="/register">Register</Link>
      </p>
    </div>
  );
}
