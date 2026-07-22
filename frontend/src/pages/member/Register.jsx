import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import HCaptcha from '@hcaptcha/react-hcaptcha';
import axiosClient from '../../api/axiosClient';
import { usePasswordStrength } from '../../hooks/usePasswordStrength';
import PasswordStrengthMeter from '../../components/forms/PasswordStrengthMeter';

const CAPTCHA_SITE_KEY = import.meta.env.VITE_CAPTCHA_SITE_KEY;

export default function Register() {
  const navigate = useNavigate();
  const captchaRef = useRef(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [captchaToken, setCaptchaToken] = useState(null);
  const [errors, setErrors] = useState([]);
  const [submitting, setSubmitting] = useState(false);

  const strength = usePasswordStrength(password, { name, email });

  async function handleSubmit(e) {
    e.preventDefault();
    setErrors([]);

    if (password !== confirmPassword) {
      setErrors(['Passwords do not match']);
      return;
    }
    if (!captchaToken) {
      setErrors(['Please complete the CAPTCHA']);
      return;
    }

    setSubmitting(true);
    try {
      await axiosClient.post('/api/auth/register', { name, email, password, captchaToken });
      navigate('/login', { state: { registered: true, email } });
    } catch (err) {
      const data = err.response?.data;
      setErrors(data?.errors || [data?.error || 'Registration failed. Please try again.']);
      captchaRef.current?.resetCaptcha();
      setCaptchaToken(null);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <h1>Register</h1>

      {errors.length > 0 ? (
        <div role="alert" id="register-errors">
          <ul>
            {errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <form onSubmit={handleSubmit} noValidate>
        <div>
          <label htmlFor="register-name">Name</label>
          <input
            id="register-name"
            name="name"
            type="text"
            autoComplete="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-describedby={errors.length ? 'register-errors' : undefined}
          />
        </div>

        <div>
          <label htmlFor="register-email">Email</label>
          <input
            id="register-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            aria-describedby={errors.length ? 'register-errors' : undefined}
          />
        </div>

        <div>
          <label htmlFor="register-password">Password</label>
          <input
            id="register-password"
            name="password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            aria-describedby="register-password-strength"
          />
          <div id="register-password-strength">
            <PasswordStrengthMeter strength={strength} />
          </div>
        </div>

        <div>
          <label htmlFor="register-confirm-password">Confirm password</label>
          <input
            id="register-confirm-password"
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            required
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            aria-describedby={errors.length ? 'register-errors' : undefined}
          />
        </div>

        <HCaptcha
          ref={captchaRef}
          sitekey={CAPTCHA_SITE_KEY}
          onVerify={(token) => setCaptchaToken(token)}
          onExpire={() => setCaptchaToken(null)}
        />

        <button type="submit" disabled={submitting}>
          {submitting ? 'Registering…' : 'Register'}
        </button>
      </form>

      <p>
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </div>
  );
}
