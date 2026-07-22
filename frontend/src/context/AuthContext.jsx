import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { startAuthentication } from '@simplewebauthn/browser';
import axiosClient, { setCsrfToken } from '../api/axiosClient';

const AuthContext = createContext(null);

// GET /api/csrf-token derives the session from the refresh-token cookie, so
// this only succeeds once a session actually exists (post-login or on
// app-load if already authenticated). A failure here just means there's no
// session yet to bind a token to — not a real error.
async function refreshCsrfToken() {
  try {
    const { data } = await axiosClient.get('/api/csrf-token');
    setCsrfToken(data.csrfToken);
  } catch (err) {
    setCsrfToken(null);
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refreshUser = useCallback(async () => {
    try {
      const { data } = await axiosClient.get('/api/auth/me');
      setUser(data.user);
      await refreshCsrfToken();
      return data.user;
    } catch (err) {
      setUser(null);
      setCsrfToken(null);
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      try {
        const { data } = await axiosClient.get('/api/auth/me');
        if (cancelled) return;
        setUser(data.user);
        await refreshCsrfToken();
      } catch (err) {
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email, password, captchaToken) => {
    const { data } = await axiosClient.post('/api/auth/login', { email, password, captchaToken });

    if (data.mfaRequired) {
      // No session exists yet — caller routes to the MFA challenge screen
      // and completes the login via completeMfaChallenge below.
      return { mfaRequired: true, mfaPendingToken: data.mfaPendingToken };
    }

    setUser(data.user);
    await refreshCsrfToken();
    return { mfaRequired: false };
  }, []);

  const completeMfaChallenge = useCallback(async (mfaPendingToken, token) => {
    const { data } = await axiosClient.post('/api/auth/mfa/challenge', { mfaPendingToken, token });
    setUser(data.user);
    await refreshCsrfToken();
  }, []);

  // Passwordless login: options/verify is a two-step ceremony keyed by email
  // (there's no session yet to identify the account any other way). Mirrors
  // the password path's mfaRequired branch exactly, since an account can
  // have both a passkey and TOTP MFA enrolled at once.
  const loginWithPasskey = useCallback(async (email) => {
    const { data: options } = await axiosClient.post('/api/auth/webauthn/login-options', { email });
    const response = await startAuthentication({ optionsJSON: options });
    const { data } = await axiosClient.post('/api/auth/webauthn/login-verify', { email, response });

    if (data.mfaRequired) {
      return { mfaRequired: true, mfaPendingToken: data.mfaPendingToken };
    }

    setUser(data.user);
    await refreshCsrfToken();
    return { mfaRequired: false };
  }, []);

  const logout = useCallback(async () => {
    try {
      await axiosClient.post('/api/auth/logout');
    } finally {
      setUser(null);
      setCsrfToken(null);
    }
  }, []);

  const value = {
    user,
    loading,
    isAuthenticated: Boolean(user),
    login,
    completeMfaChallenge,
    loginWithPasskey,
    logout,
    refreshUser,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return ctx;
}
