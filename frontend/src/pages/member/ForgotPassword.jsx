import { useState } from 'react';
import { useLocation, Link } from 'react-router-dom';
import axiosClient from '../../api/axiosClient';

export default function ForgotPassword() {
  const location = useLocation();
  const [email, setEmail] = useState(location.state?.email || '');
  const [submitted, setSubmitted] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitting(true);
    try {
      // The backend always returns the same generic response whether or not
      // the account exists — that's the enumeration defense, so there's
      // nothing else to branch on here regardless of outcome.
      await axiosClient.post('/api/auth/forgot-password', { email });
    } finally {
      setSubmitting(false);
      setSubmitted(true);
    }
  }

  return (
    <div>
      <h1>Forgot password</h1>

      {location.state?.passwordExpired ? (
        <div role="alert">
          Your password has expired. Request a reset link below to set a new one.
        </div>
      ) : null}

      {submitted ? (
        <p role="status">
          If an account with that email exists, a password reset link has been sent.
        </p>
      ) : (
        <form onSubmit={handleSubmit} noValidate>
          <div>
            <label htmlFor="forgot-email">Email</label>
            <input
              id="forgot-email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <button type="submit" disabled={submitting}>
            {submitting ? 'Sending…' : 'Send reset link'}
          </button>
        </form>
      )}

      <p>
        <Link to="/login">Back to login</Link>
      </p>
    </div>
  );
}
