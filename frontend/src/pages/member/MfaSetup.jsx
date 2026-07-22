import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axiosClient from '../../api/axiosClient';

export default function MfaSetup() {
  const [setupData, setSetupData] = useState(null);
  const [alreadyEnabled, setAlreadyEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [code, setCode] = useState('');
  const [error, setError] = useState(null);
  const [confirmed, setConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function startSetup() {
      try {
        const { data } = await axiosClient.post('/api/auth/mfa/setup');
        if (!cancelled) setSetupData(data);
      } catch (err) {
        if (cancelled) return;
        if (err.response?.status === 400) {
          setAlreadyEnabled(true);
        } else {
          setError(err.response?.data?.error || 'Could not start MFA setup');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    startSetup();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleVerify(e) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await axiosClient.post('/api/auth/mfa/verify-setup', { token: code });
      setConfirmed(true);
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid verification code');
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return <div>Loading…</div>;
  }

  if (alreadyEnabled) {
    return (
      <div>
        <h1>Two-factor authentication</h1>
        <p>MFA is already enabled for your account.</p>
        <Link to="/settings">Back to settings</Link>
      </div>
    );
  }

  if (confirmed) {
    return (
      <div>
        <h1>Two-factor authentication</h1>
        <p role="status">MFA has been enabled for your account.</p>
        <Link to="/settings">Back to settings</Link>
      </div>
    );
  }

  return (
    <div>
      <h1>Set up two-factor authentication</h1>

      {error ? (
        <div role="alert" id="mfa-setup-error">
          {error}
        </div>
      ) : null}

      {setupData ? (
        <>
          <p>Scan this QR code with your authenticator app (e.g. Google Authenticator, Authy).</p>
          <img src={setupData.qrCodeDataUrl} alt="MFA enrollment QR code" width={200} height={200} />
          <p>Or enter this URL manually: {setupData.otpauthUrl}</p>
        </>
      ) : null}

      <form onSubmit={handleVerify} noValidate>
        <div>
          <label htmlFor="mfa-setup-code">Enter the 6-digit code from your app</label>
          <input
            id="mfa-setup-code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            aria-describedby={error ? 'mfa-setup-error' : undefined}
          />
        </div>
        <button type="submit" disabled={submitting}>
          {submitting ? 'Verifying…' : 'Confirm and enable MFA'}
        </button>
      </form>
    </div>
  );
}
