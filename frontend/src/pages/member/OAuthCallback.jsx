import { useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext.jsx';

// Landing page for the backend's post-Google-login redirect
// (?status=success). The backend already set the session cookies via its
// own redirect — this page's only job is to tell AuthContext to pick that
// session up, since nothing in the SPA's own state knows about it yet.
export default function OAuthCallback() {
  const { refreshUser } = useAuth();
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    refreshUser().then((user) => {
      if (cancelled) return;
      if (!user) setFailed(true);
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshUser]);

  if (!ready) {
    return <div>Signing you in…</div>;
  }

  if (failed) {
    return <Navigate to="/login?oauthError=oauth_failed" replace />;
  }

  return <Navigate to="/" replace />;
}
