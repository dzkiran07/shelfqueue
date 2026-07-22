import { useCallback, useEffect, useState } from 'react';
import axiosClient from '../../api/axiosClient';
import Badge from '../../components/ui/Badge.jsx';

const PAGE_LIMIT = 8;

function formatDate(value) {
  if (!value) return null;
  return new Date(value).toLocaleDateString();
}

function Pagination({ label, pagination, page, onPageChange }) {
  if (!pagination || pagination.totalPages <= 1) return null;
  return (
    <nav aria-label={`${label} pagination`}>
      <button type="button" onClick={() => onPageChange(Math.max(1, page - 1))} disabled={page <= 1}>
        Previous
      </button>
      <span aria-live="polite">
        Page {pagination.page} of {pagination.totalPages}
      </span>
      <button
        type="button"
        onClick={() => onPageChange(Math.min(pagination.totalPages, page + 1))}
        disabled={page >= pagination.totalPages}
      >
        Next
      </button>
    </nav>
  );
}

export default function LoanApprovals() {
  const [pending, setPending] = useState([]);
  const [approved, setApproved] = useState([]);
  const [checkedOut, setCheckedOut] = useState([]);
  const [pendingPagination, setPendingPagination] = useState(null);
  const [approvedPagination, setApprovedPagination] = useState(null);
  const [checkedOutPagination, setCheckedOutPagination] = useState(null);
  const [pendingPage, setPendingPage] = useState(1);
  const [approvedPage, setApprovedPage] = useState(1);
  const [checkedOutPage, setCheckedOutPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionState, setActionState] = useState({});

  const loadLoans = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pendingRes, approvedRes, checkedOutRes] = await Promise.all([
        axiosClient.get('/api/admin/loans', { params: { status: 'requested', page: pendingPage, limit: PAGE_LIMIT } }),
        axiosClient.get('/api/admin/loans', { params: { status: 'approved', page: approvedPage, limit: PAGE_LIMIT } }),
        axiosClient.get('/api/admin/loans', {
          params: { status: 'checked_out,overdue', page: checkedOutPage, limit: PAGE_LIMIT },
        }),
      ]);
      setPending(pendingRes.data.loans);
      setPendingPagination(pendingRes.data.pagination);
      setApproved(approvedRes.data.loans);
      setApprovedPagination(approvedRes.data.pagination);
      setCheckedOut(checkedOutRes.data.loans);
      setCheckedOutPagination(checkedOutRes.data.pagination);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load loans.');
    } finally {
      setLoading(false);
    }
  }, [pendingPage, approvedPage, checkedOutPage]);

  useEffect(() => {
    loadLoans();
  }, [loadLoans]);

  async function runAction(loanId, action, body) {
    setActionState((prev) => ({ ...prev, [loanId]: { pending: true } }));
    try {
      await axiosClient.patch(`/api/admin/loans/${loanId}/${action}`, body);
      await loadLoans();
    } catch (err) {
      setActionState((prev) => ({
        ...prev,
        [loanId]: { pending: false, error: err.response?.data?.error || `Could not ${action.replace('-', ' ')} this loan.` },
      }));
      return;
    }
    setActionState((prev) => ({ ...prev, [loanId]: { pending: false } }));
  }

  return (
    <div>
      <h1>Loan approvals</h1>

      {error ? <div role="alert">{error}</div> : null}

      {loading ? (
        <p aria-live="polite">Loading loans…</p>
      ) : (
        <>
          <section>
            <h2>Pending requests</h2>
            {pending.length === 0 ? (
              <p>No pending loan requests.</p>
            ) : (
              <ul aria-label="Pending loan requests">
                {pending.map((loan) => {
                  const action = actionState[loan._id];
                  return (
                    <li key={loan._id}>
                      <h3>{loan.bookId?.title || 'Untitled'}</h3>
                      <p>{loan.bookId?.author}</p>
                      <p>
                        Requested by {loan.memberId?.name} ({loan.memberId?.email}) on{' '}
                        {formatDate(loan.requestedAt)}
                      </p>
                      {loan.memberNote ? <p>Member note: {loan.memberNote}</p> : null}
                      {action?.error ? <div role="alert">{action.error}</div> : null}
                      <button
                        type="button"
                        onClick={() => runAction(loan._id, 'approve')}
                        disabled={action?.pending}
                        aria-label={`Approve loan of ${loan.bookId?.title} for ${loan.memberId?.name}`}
                      >
                        {action?.pending ? 'Working…' : 'Approve'}
                      </button>
                      <button
                        type="button"
                        onClick={() => runAction(loan._id, 'reject')}
                        disabled={action?.pending}
                        aria-label={`Reject loan of ${loan.bookId?.title} for ${loan.memberId?.name}`}
                      >
                        {action?.pending ? 'Working…' : 'Reject'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <Pagination label="Pending requests" pagination={pendingPagination} page={pendingPage} onPageChange={setPendingPage} />
          </section>

          <section>
            <h2>Approved (ready for pickup)</h2>
            {approved.length === 0 ? (
              <p>No approved loans awaiting pickup.</p>
            ) : (
              <ul aria-label="Approved loans awaiting pickup">
                {approved.map((loan) => {
                  const action = actionState[loan._id];
                  return (
                    <li key={loan._id}>
                      <h3>{loan.bookId?.title || 'Untitled'}</h3>
                      <p>{loan.bookId?.author}</p>
                      <p>
                        Approved for {loan.memberId?.name} ({loan.memberId?.email})
                      </p>
                      {action?.error ? <div role="alert">{action.error}</div> : null}
                      <button
                        type="button"
                        onClick={() => runAction(loan._id, 'mark-checked-out')}
                        disabled={action?.pending}
                        aria-label={`Mark ${loan.bookId?.title} as checked out for ${loan.memberId?.name}`}
                      >
                        {action?.pending ? 'Working…' : 'Mark checked out'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <Pagination
              label="Approved loans"
              pagination={approvedPagination}
              page={approvedPage}
              onPageChange={setApprovedPage}
            />
          </section>

          <section>
            <h2>Checked-out loans</h2>
            {checkedOut.length === 0 ? (
              <p>No checked-out loans.</p>
            ) : (
              <ul aria-label="Checked-out loans">
                {checkedOut.map((loan) => {
                  const action = actionState[loan._id];
                  return (
                    <li key={loan._id}>
                      <h3>{loan.bookId?.title || 'Untitled'}</h3>
                      <p>{loan.bookId?.author}</p>
                      <p>
                        Borrowed by {loan.memberId?.name} ({loan.memberId?.email})
                      </p>
                      <p>
                        Status:{' '}
                        <Badge tone={loan.status === 'overdue' ? 'danger' : 'info'}>
                          {loan.status === 'overdue' ? 'Overdue' : 'Checked out'}
                        </Badge>
                        {loan.dueDate ? ` — due ${formatDate(loan.dueDate)}` : ''}
                      </p>
                      {action?.error ? <div role="alert">{action.error}</div> : null}
                      <button
                        type="button"
                        onClick={() => runAction(loan._id, 'mark-returned')}
                        disabled={action?.pending}
                        aria-label={`Mark ${loan.bookId?.title} as returned`}
                      >
                        {action?.pending ? 'Working…' : 'Mark returned'}
                      </button>
                      <button
                        type="button"
                        onClick={() => runAction(loan._id, 'mark-lost')}
                        disabled={action?.pending}
                        aria-label={`Mark ${loan.bookId?.title} as lost`}
                      >
                        {action?.pending ? 'Working…' : 'Mark lost'}
                      </button>
                      <button
                        type="button"
                        onClick={() => runAction(loan._id, 'mark-damaged')}
                        disabled={action?.pending}
                        aria-label={`Mark ${loan.bookId?.title} as damaged`}
                      >
                        {action?.pending ? 'Working…' : 'Mark damaged'}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <Pagination
              label="Checked-out loans"
              pagination={checkedOutPagination}
              page={checkedOutPage}
              onPageChange={setCheckedOutPage}
            />
          </section>
        </>
      )}
    </div>
  );
}
