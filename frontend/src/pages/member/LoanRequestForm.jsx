import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import axiosClient from '../../api/axiosClient';

export default function LoanRequestForm() {
  const [searchParams] = useSearchParams();
  const bookId = searchParams.get('bookId');
  const navigate = useNavigate();

  const [book, setBook] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [memberNote, setMemberNote] = useState('');
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [offerWaitlist, setOfferWaitlist] = useState(false);

  useEffect(() => {
    if (!bookId) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    axiosClient
      .get(`/api/books/${bookId}`)
      .then(({ data }) => {
        if (!cancelled) setBook(data.book);
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err.response?.data?.error || 'Could not load this title.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  async function handleSubmit(e) {
    e.preventDefault();
    setSubmitError(null);
    setOfferWaitlist(false);
    setSubmitting(true);
    try {
      await axiosClient.post('/api/loans', { bookId, memberNote: memberNote || undefined });
      navigate('/my-loans', { state: { requested: true } });
    } catch (err) {
      const data = err.response?.data;
      setSubmitError(data?.error || 'Could not submit the loan request. Please try again.');
      setOfferWaitlist(Boolean(data?.joinWaitlist));
    } finally {
      setSubmitting(false);
    }
  }

  if (!bookId) {
    return (
      <div>
        <h1>Request a loan</h1>
        <div role="alert">No title was selected. Choose a book from the catalog first.</div>
        <p>
          <Link to="/catalog">Back to catalog</Link>
        </p>
      </div>
    );
  }

  if (loading) {
    return <div aria-live="polite">Loading…</div>;
  }

  if (loadError || !book) {
    return (
      <div>
        <h1>Request a loan</h1>
        <div role="alert">{loadError || 'This title could not be found.'}</div>
        <p>
          <Link to="/catalog">Back to catalog</Link>
        </p>
      </div>
    );
  }

  const available = book.copiesAvailable > 0;

  return (
    <div>
      <h1>Request a loan</h1>

      <h2>{book.title}</h2>
      <p>{book.author}</p>

      {!available ? (
        <div role="alert">
          No copies of this title are currently available.{' '}
          <Link to="/catalog">Return to the catalog to join the waitlist.</Link>
        </div>
      ) : (
        <form onSubmit={handleSubmit} noValidate>
          {submitError ? (
            <div role="alert" id="loan-request-error">
              {submitError}
              {offerWaitlist ? (
                <p>
                  <Link to="/catalog">Join the waitlist for this title instead.</Link>
                </p>
              ) : null}
            </div>
          ) : null}

          <div>
            <label htmlFor="loan-member-note">Note to the librarian (optional)</label>
            <textarea
              id="loan-member-note"
              name="memberNote"
              value={memberNote}
              onChange={(e) => setMemberNote(e.target.value)}
              aria-describedby={submitError ? 'loan-request-error' : undefined}
            />
          </div>

          <button type="submit" disabled={submitting}>
            {submitting ? 'Submitting…' : 'Submit loan request'}
          </button>
        </form>
      )}

      <p>
        <Link to="/catalog">Back to catalog</Link>
      </p>
    </div>
  );
}
