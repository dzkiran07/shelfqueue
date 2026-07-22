import { useCallback, useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import axiosClient from '../../api/axiosClient';
import Badge from '../../components/ui/Badge.jsx';

const STATUS_LABELS = {
  requested: 'Requested',
  approved: 'Approved — awaiting pickup',
  rejected: 'Rejected',
  checked_out: 'Checked out',
  returned: 'Returned',
  overdue: 'Overdue',
  lost: 'Lost',
  damaged: 'Damaged',
  cancelled: 'Cancelled',
};

const STATUS_TONES = {
  requested: 'info',
  approved: 'warning',
  rejected: 'danger',
  checked_out: 'info',
  returned: 'success',
  overdue: 'danger',
  lost: 'danger',
  damaged: 'warning',
  cancelled: 'neutral',
};

function isOverdue(loan) {
  if (loan.status === 'overdue') return true;
  return loan.status === 'checked_out' && loan.dueDate && new Date(loan.dueDate) < new Date();
}

function formatDate(value) {
  if (!value) return null;
  return new Date(value).toLocaleDateString();
}

export default function MyLoans() {
  const location = useLocation();
  const [loans, setLoans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [cancelling, setCancelling] = useState({});
  const [cancelError, setCancelError] = useState(null);

  const loadLoans = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await axiosClient.get('/api/loans/me');
      setLoans(data.loans);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load your loans. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadLoans();
  }, [loadLoans]);

  async function handleCancel(loanId) {
    setCancelError(null);
    setCancelling((prev) => ({ ...prev, [loanId]: true }));
    try {
      await axiosClient.delete(`/api/loans/${loanId}`);
      await loadLoans();
    } catch (err) {
      setCancelError(err.response?.data?.error || 'Could not cancel this loan request.');
    } finally {
      setCancelling((prev) => ({ ...prev, [loanId]: false }));
    }
  }

  return (
    <div>
      <h1>My loans</h1>

      {location.state?.requested ? <p role="status">Loan request submitted.</p> : null}
      {cancelError ? <div role="alert">{cancelError}</div> : null}

      {error ? <div role="alert">{error}</div> : null}

      {loading ? (
        <p aria-live="polite">Loading your loans…</p>
      ) : loans.length === 0 ? (
        <p>
          You have no loans yet. <Link to="/catalog">Browse the catalog</Link>.
        </p>
      ) : (
        <ul aria-label="Your loans">
          {loans.map((loan) => {
            const overdue = isOverdue(loan);
            const canCancel = loan.status === 'requested';
            const dueDate = formatDate(loan.dueDate);

            return (
              <li key={loan._id}>
                <h2>{loan.bookId?.title || 'Untitled'}</h2>
                {loan.bookId?.author ? <p>{loan.bookId.author}</p> : null}

                <p>
                  Status:{' '}
                  <Badge tone={overdue ? 'danger' : STATUS_TONES[loan.status] || 'neutral'}>
                    {overdue ? 'Overdue' : STATUS_LABELS[loan.status] || loan.status}
                  </Badge>
                </p>

                {dueDate ? <p>Due {dueDate}</p> : null}
                {loan.memberNote ? <p>Your note: {loan.memberNote}</p> : null}

                {canCancel ? (
                  <button
                    type="button"
                    onClick={() => handleCancel(loan._id)}
                    disabled={cancelling[loan._id]}
                    aria-label={`Cancel loan request for ${loan.bookId?.title || 'this title'}`}
                  >
                    {cancelling[loan._id] ? 'Cancelling…' : 'Cancel request'}
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
