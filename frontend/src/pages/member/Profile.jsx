import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { startRegistration } from '@simplewebauthn/browser';
import axiosClient from '../../api/axiosClient';
import { useAuth } from '../../context/AuthContext.jsx';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || 'http://localhost:5000';

function formatTimestamp(value) {
  if (!value) return 'Unknown';
  return new Date(value).toLocaleString();
}

function triggerDownload(filename, jsonData) {
  const blob = new Blob([JSON.stringify(jsonData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export default function Profile() {
  const { refreshUser } = useAuth();
  const fileInputRef = useRef(null);

  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  // Profile edit form
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [emailNotifications, setEmailNotifications] = useState(true);
  const [profileErrors, setProfileErrors] = useState([]);
  const [profileSuccess, setProfileSuccess] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);

  // Export/import
  const [exportError, setExportError] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [importing, setImporting] = useState(false);

  // Sessions
  const [sessions, setSessions] = useState([]);
  const [sessionsLoading, setSessionsLoading] = useState(true);
  const [sessionsError, setSessionsError] = useState(null);
  const [revoking, setRevoking] = useState({});

  // Passkey / MFA / Google (Phase 27)
  const [passkeyStatus, setPasskeyStatus] = useState(null);
  const [enrolling, setEnrolling] = useState(false);

  function applyProfile(user) {
    setProfile(user);
    setName(user.name || '');
    setPhone(user.phone || '');
    setEmailNotifications(user.notificationPreferences?.email ?? true);
  }

  const loadProfile = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axiosClient.get('/api/users/me');
      applyProfile(data.user);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadSessions = useCallback(async () => {
    setSessionsLoading(true);
    setSessionsError(null);
    try {
      const { data } = await axiosClient.get('/api/auth/sessions');
      setSessions(data.sessions);
    } catch (err) {
      setSessionsError(err.response?.data?.error || 'Could not load active sessions.');
    } finally {
      setSessionsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProfile();
    loadSessions();
  }, [loadProfile, loadSessions]);

  async function handleProfileSubmit(e) {
    e.preventDefault();
    setProfileErrors([]);
    setProfileSuccess(false);
    setSavingProfile(true);
    try {
      const { data } = await axiosClient.patch('/api/users/me', {
        name,
        phone: phone || null,
        notificationPreferences: { email: emailNotifications },
      });
      applyProfile(data.user);
      setProfileSuccess(true);
    } catch (err) {
      const errData = err.response?.data;
      const messages = errData?.details
        ? errData.details.map((d) => d.message)
        : [errData?.error || 'Could not save your profile. Please try again.'];
      setProfileErrors(messages);
    } finally {
      setSavingProfile(false);
    }
  }

  async function handleExport() {
    setExportError(null);
    setExporting(true);
    try {
      const { data } = await axiosClient.get('/api/users/me/export');
      triggerDownload(`shelfqueue-export-${profile?.id || 'me'}.json`, data);
    } catch (err) {
      setExportError(err.response?.data?.error || 'Could not export your data. Please try again.');
    } finally {
      setExporting(false);
    }
  }

  async function handleImport(e) {
    e.preventDefault();
    setImportResult(null);

    const file = fileInputRef.current?.files?.[0];
    if (!file) {
      setImportResult({ ok: false, message: 'Choose a JSON file to import first.' });
      return;
    }

    setImporting(true);
    try {
      const text = await file.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (parseErr) {
        setImportResult({ ok: false, message: 'That file is not valid JSON.' });
        return;
      }

      // Only the `profile` portion of a previously exported file is
      // restorable — the import endpoint rejects any other top-level keys
      // (exportedAt, loans), so those are deliberately dropped here rather
      // than sent along and rejected.
      const { data } = await axiosClient.post('/api/users/me/import', { profile: parsed.profile || {} });
      applyProfile(data.user);
      setImportResult({ ok: true, message: 'Profile preferences imported successfully.' });
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      const errData = err.response?.data;
      const messages = errData?.details
        ? errData.details.map((d) => `${d.path}: ${d.message}`).join('; ')
        : errData?.error || 'Could not import this file. Please try again.';
      setImportResult({ ok: false, message: messages });
    } finally {
      setImporting(false);
    }
  }

  async function handleRevokeSession(sessionId) {
    setRevoking((prev) => ({ ...prev, [sessionId]: true }));
    try {
      await axiosClient.delete(`/api/auth/sessions/${sessionId}`);
      await loadSessions();
      // Revoking may have been the session currently in use — re-sync auth
      // state so ProtectedRoute redirects to /login if it was.
      await refreshUser();
    } catch (err) {
      setSessionsError(err.response?.data?.error || 'Could not revoke this session.');
      setRevoking((prev) => ({ ...prev, [sessionId]: false }));
      return;
    }
    setRevoking((prev) => ({ ...prev, [sessionId]: false }));
  }

  async function handleAddPasskey() {
    setPasskeyStatus(null);
    setEnrolling(true);
    try {
      const { data: options } = await axiosClient.post('/api/auth/webauthn/register-options');
      const response = await startRegistration({ optionsJSON: options });
      await axiosClient.post('/api/auth/webauthn/register-verify', { response });
      setPasskeyStatus({ ok: true, message: 'Passkey added successfully.' });
    } catch (err) {
      setPasskeyStatus({
        ok: false,
        message: err.response?.data?.error || 'Could not add passkey. Please try again.',
      });
    } finally {
      setEnrolling(false);
    }
  }

  function handleConnectGoogle() {
    window.location.href = `${API_BASE_URL}/api/auth/google/link`;
  }

  if (loading) {
    return <div>Loading…</div>;
  }

  const googleConnected = profile?.oauthProviders?.includes('google');

  return (
    <div>
      <h1>Settings</h1>

      <section>
        <h2>Profile</h2>

        {profileErrors.length > 0 ? (
          <div role="alert" id="profile-errors">
            <ul>
              {profileErrors.map((msg) => (
                <li key={msg}>{msg}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {profileSuccess ? <p role="status">Profile updated.</p> : null}

        <form onSubmit={handleProfileSubmit} noValidate>
          <div>
            <label htmlFor="profile-email">Email</label>
            <input id="profile-email" type="email" value={profile?.email || ''} readOnly disabled />
          </div>

          <div>
            <label htmlFor="profile-name">Name</label>
            <input
              id="profile-name"
              name="name"
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-describedby={profileErrors.length ? 'profile-errors' : undefined}
            />
          </div>

          <div>
            <label htmlFor="profile-phone">Phone (optional)</label>
            <input
              id="profile-phone"
              name="phone"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              aria-describedby={profileErrors.length ? 'profile-errors' : undefined}
            />
          </div>

          <div>
            <input
              id="profile-email-notifications"
              name="emailNotifications"
              type="checkbox"
              checked={emailNotifications}
              onChange={(e) => setEmailNotifications(e.target.checked)}
            />
            <label htmlFor="profile-email-notifications">Send me email notifications</label>
          </div>

          <button type="submit" disabled={savingProfile}>
            {savingProfile ? 'Saving…' : 'Save profile'}
          </button>
        </form>
      </section>

      <section>
        <h2>Your data</h2>

        <div>
          <p>Download a copy of your profile and loan history as a JSON file.</p>
          {exportError ? <div role="alert">{exportError}</div> : null}
          <button type="button" onClick={handleExport} disabled={exporting}>
            {exporting ? 'Preparing export…' : 'Export my data'}
          </button>
        </div>

        <div>
          <h3>Import profile preferences</h3>
          <form onSubmit={handleImport} noValidate>
            <div>
              <label htmlFor="profile-import-file">Choose a previously exported JSON file</label>
              <input
                id="profile-import-file"
                name="importFile"
                type="file"
                accept="application/json,.json"
                ref={fileInputRef}
                aria-describedby={importResult ? 'import-result' : undefined}
              />
            </div>
            {importResult ? (
              <div role={importResult.ok ? 'status' : 'alert'} id="import-result">
                {importResult.message}
              </div>
            ) : null}
            <button type="submit" disabled={importing}>
              {importing ? 'Importing…' : 'Import'}
            </button>
          </form>
        </div>
      </section>

      <section>
        <h2>Manage active sessions</h2>

        {sessionsError ? <div role="alert">{sessionsError}</div> : null}

        {sessionsLoading ? (
          <p aria-live="polite">Loading sessions…</p>
        ) : sessions.length === 0 ? (
          <p>No active sessions found.</p>
        ) : (
          <ul aria-label="Active sessions">
            {sessions.map((session) => (
              <li key={session.id}>
                <p>{session.userAgent || 'Unknown device'}</p>
                <p>Signed in: {formatTimestamp(session.createdAt)}</p>
                <p>Last used: {formatTimestamp(session.lastUsedAt)}</p>
                <button
                  type="button"
                  onClick={() => handleRevokeSession(session.id)}
                  disabled={revoking[session.id]}
                  aria-label={`Revoke session last used ${formatTimestamp(session.lastUsedAt)}`}
                >
                  {revoking[session.id] ? 'Revoking…' : 'Revoke'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Security</h2>

        <div>
          <p>Two-factor authentication: {profile?.mfaEnabled ? 'Enabled' : 'Disabled'}</p>
          {!profile?.mfaEnabled ? <Link to="/mfa-setup">Set up two-factor authentication</Link> : null}
        </div>

        <div>
          <p>Google account: {googleConnected ? 'Connected' : 'Not connected'}</p>
          {!googleConnected ? (
            <button type="button" onClick={handleConnectGoogle}>
              Connect Google
            </button>
          ) : null}
        </div>

        <div>
          <p>Passkeys let you sign in without a password using this device&rsquo;s built-in authenticator.</p>
          {passkeyStatus ? (
            <div role={passkeyStatus.ok ? 'status' : 'alert'}>{passkeyStatus.message}</div>
          ) : null}
          <button type="button" onClick={handleAddPasskey} disabled={enrolling}>
            {enrolling ? 'Waiting for passkey…' : 'Add a passkey'}
          </button>
        </div>
      </section>
    </div>
  );
}
