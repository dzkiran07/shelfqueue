import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axiosClient from '../../api/axiosClient';
import Badge from '../../components/ui/Badge.jsx';

const STATUS_LABELS = {
  waiting: 'Waiting',
  offered: 'Offered',
  expired: 'Offer expired',
  fulfilled: 'Claimed',
  cancelled: 'Left queue',
};

const STATUS_TONES = {
  waiting: 'info',
  offered: 'warning',
  expired: 'danger',
  fulfilled: 'success',
  cancelled: 'neutral',
};

function formatCountdown(msRemaining) {
  if (msRemaining <= 0) return 'Expired';
  const totalSeconds = Math.floor(msRemaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h ${minutes}m ${seconds}s`;
}

export default function MyWaitlist() {
  const navigate = useNavigate();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(() => Date.now());
  const [actionState, setActionState] = useState({});

  const loadWaitlist = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await axiosClient.get('/api/waitlist/me');
      setEntries(data.waitlist);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load your waitlist entries. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWaitlist();
  }, [loadWaitlist]);

  const hasActiveOffer = entries.some(
    (entry) => entry.status === 'offered' && entry.offerExpiresAt && new Date(entry.offerExpiresAt) > new Date(now)
  );

  useEffect(() => {
    if (!hasActiveOffer) return undefined;
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, [hasActiveOffer]);

  async function handleClaim(entryId) {
    setActionState((prev) => ({ ...prev, [entryId]: { pending: true } }));
    try {
      await axiosClient.post(`/api/waitlist/${entryId}/claim`);
      navigate('/my-loans', { state: { requested: true } });
    } catch (err) {
      setActionState((prev) => ({
        ...prev,
        [entryId]: { pending: false, error: err.response?.data?.error || 'Could not claim this offer.' },
      }));
      await loadWaitlist();
    }
  }

  async function handleLeave(entryId) {
    setActionState((prev) => ({ ...prev, [entryId]: { pending: true } }));
    try {
      await axiosClient.delete(`/api/waitlist/${entryId}`);
      await loadWaitlist();
    } catch (err) {
      setActionState((prev) => ({
        ...prev,
        [entryId]: { pending: false, error: err.response?.data?.error || 'Could not leave the waitlist.' },
      }));
    }
  }

  return (
    <div>
      <h1>My waitlist</h1>

      {error ? <div role="alert">{error}</div> : null}

      {loading ? (
        <p aria-live="polite">Loading your waitlist…</p>
      ) : entries.length === 0 ? (
        <p>
          You&rsquo;re not on any waitlists. <Link to="/catalog">Browse the catalog</Link>.
        </p>
      ) : (
        <ul aria-label="Your waitlist entries">
          {entries.map((entry) => {
            const action = actionState[entry._id];
            const canLeave = entry.status === 'waiting' || entry.status === 'offered';
            const msRemaining = entry.offerExpiresAt ? new Date(entry.offerExpiresAt) - now : 0;
            const offerActive = entry.status === 'offered' && msRemaining > 0;

            return (
              <li key={entry._id}>
                <h2>{entry.bookId?.title || 'Untitled'}</h2>
                {entry.bookId?.author ? <p>{entry.bookId.author}</p> : null}

                <p>
                  Status: <Badge tone={STATUS_TONES[entry.status] || 'neutral'}>{STATUS_LABELS[entry.status] || entry.status}</Badge>
                </p>

                {entry.status === 'waiting' ? <p>Queue position: {entry.queuePosition}</p> : null}

                {offerActive ? (
                  <p role="timer" aria-live="polite">
                    Time remaining to claim: {formatCountdown(msRemaining)}
                  </p>
                ) : null}

                {action?.error ? <div role="alert">{action.error}</div> : null}

                {offerActive ? (
                  <button
                    type="button"
                    onClick={() => handleClaim(entry._id)}
                    disabled={action?.pending}
                    aria-label={`Claim offer for ${entry.bookId?.title || 'this title'}`}
                  >
                    {action?.pending ? 'Claiming…' : 'Claim this copy'}
                  </button>
                ) : null}

                {canLeave ? (
                  <button
                    type="button"
                    onClick={() => handleLeave(entry._id)}
                    disabled={action?.pending}
                    aria-label={`Leave waitlist for ${entry.bookId?.title || 'this title'}`}
                  >
                    {action?.pending ? 'Leaving…' : 'Leave waitlist'}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
