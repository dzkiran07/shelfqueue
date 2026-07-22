import { useEffect, useRef, useState } from 'react';
import axiosClient from '../api/axiosClient';

const DEBOUNCE_MS = 400;

// Live strength feedback comes from the backend's own zxcvbn scoring
// (POST /api/auth/password-strength) rather than a client-side copy, so the
// meter always matches whatever the server will actually enforce.
export function usePasswordStrength(password, { name, email } = {}) {
  const [strength, setStrength] = useState(null);
  const timeoutRef = useRef(null);

  useEffect(() => {
    clearTimeout(timeoutRef.current);

    if (!password) {
      setStrength(null);
      return undefined;
    }

    timeoutRef.current = setTimeout(async () => {
      try {
        const { data } = await axiosClient.post('/api/auth/password-strength', { password, name, email });
        setStrength(data);
      } catch (err) {
        setStrength(null);
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timeoutRef.current);
  }, [password, name, email]);

  return strength;
}
