import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axiosClient from '../../api/axiosClient';
import { usePasswordStrength } from '../../hooks/usePasswordStrength';
import PasswordStrengthMeter from '../../components/forms/PasswordStrengthMeter';

export default function ResetPassword() {
  const { token } = useParams();
  const navigate = useNavigate();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  const strength = usePasswordStrength(password);

  async function handleSubmit(e) {
    e.preventDefault();
    setErrors([]);

    if (password !== confirmPassword) {
      setErrors(['Passwords do not match']);
      return;
    }

    setSubmitting(true);
    try {
      await axiosClient.post(`/api/auth/reset-password/${token}`, { password });
      navigate('/login', { state: { passwordReset: true } });
    } catch (err) {
      const data = err.response?.data;
      setErrors(data?.errors || [data?.error || 'Could not reset password. Please try again.']);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>Reset password</h1>

      {errors.length > 0 ? (
        <div role="alert" id="reset-errors">
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <form onSubmit={handleSubmit} noValidate>
        <div>
          <label htmlFor="reset-password">New password</label>
          <input
            id="reset-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby="reset-password-strength"
          />
          <div id="reset-password-strength">
            <PasswordStrengthMeter strength={strength} />
          </div>
        </div>

        <div>
          <label htmlFor="reset-confirm-password">Confirm new password</label>
          <input
            id="reset-confirm-password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            aria-describedby={errors.length ? 'reset-errors' : undefined}
          />
        </div>

        <button type="submit" disabled={submitting}>
          {submitting ? 'Resetting…' : 'Reset password'}
        </button>
      </form>

      <p>
        <Link to="/login">Back to login</Link>
      </p>
    </div>
  );
}
