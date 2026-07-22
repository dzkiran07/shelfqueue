import { useCallback, useEffect, useState } from 'react';
import axiosClient from '../../api/axiosClient';
import Badge from '../../components/ui/Badge.jsx';

function formatCountdown(offerExpiresAt) {
  if (!offerExpiresAt) return null;
  const msRemaining = new Date(offerExpiresAt) - new Date();
  if (msRemaining <= 0) return 'Expired';
  const hours = Math.floor(msRemaining / (60 * 60 * 1000));
  const minutes = Math.floor((msRemaining % (60 * 60 * 1000)) / (60 * 1000));
  return `${hours}h ${minutes}m remaining`;
}

export default function WaitlistManager() {
  const [books, setBooks] = useState([]);
  const [booksPagination, setBooksPagination] = useState(null);
  const [booksPage, setBooksPage] = useState(1);
  const [booksLoading, setBooksLoading] = useState(true);
  const [booksError, setBooksError] = useState(null);
  const [authorFilter, setAuthorFilter] = useState('');

  const [selectedBook, setSelectedBook] = useState(null);
  const [entries, setEntries] = useState([]);
  const [queueLoading, setQueueLoading] = useState(false);
  const [queueError, setQueueError] = useState(null);

  const [offering, setOffering] = useState(false);
  const [entryAction, setEntryAction] = useState({});

  const loadBooks = useCallback(async () => {
    setBooksLoading(true);
    setBooksError(null);
    try {
      const { data } = await axiosClient.get('/api/books', {
        params: { page: booksPage, ...(authorFilter ? { author: authorFilter } : {}) },
      });
      setBooks(data.books);
      setBooksPagination(data.pagination);
    } catch (err) {
      setBooksError(err.response?.data?.error || 'Could not load the catalog.');
    } finally {
      setBooksLoading(false);
    }
  }, [authorFilter, booksPage]);

  useEffect(() => {
    loadBooks();
  }, [loadBooks]);

  const loadQueue = useCallback(async (bookId) => {
    setQueueLoading(true);
    setQueueError(null);
    try {
      const { data } = await axiosClient.get('/api/admin/waitlist', { params: { bookId } });
      setEntries(data.waitlist);
    } catch (err) {
      setQueueError(err.response?.data?.error || 'Could not load the waitlist for this title.');
    } finally {
      setQueueLoading(false);
    }
  }, []);

  function handleSelectBook(book) {
    setSelectedBook(book);
    setEntryAction({});
    loadQueue(book._id);
  }

  async function handleOfferNext() {
    if (!selectedBook) return;
    setOffering(true);
    setQueueError(null);
    try {
      const { data } = await axiosClient.post('/api/admin/waitlist/offer-next', { bookId: selectedBook._id });
      if (!data.offered) {
        setQueueError('No one is currently waiting for this title.');
      }
      await loadQueue(selectedBook._id);
    } catch (err) {
      setQueueError(err.response?.data?.error || 'Could not make an offer for this title.');
    } finally {
      setOffering(false);
    }
  }

  async function handleSkip(entryId) {
    setEntryAction((prev) => ({ ...prev, [entryId]: { pending: true } }));
    try {
      await axiosClient.post(`/api/admin/waitlist/${entryId}/skip`);
      await loadQueue(selectedBook._id);
    } catch (err) {
      setEntryAction((prev) => ({
        ...prev,
        [entryId]: { pending: false, error: err.response?.data?.error || 'Could not skip this entry.' },
      }));
      return;
    }
    setEntryAction((prev) => ({ ...prev, [entryId]: { pending: false } }));
  }

  return (
    <div>
      <h1>Waitlist manager</h1>

      <section>
        <h2>Choose a title</h2>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            setBooksPage(1);
          }}
          role="search"
          aria-label="Filter titles by author"
          noValidate
        >
          <label htmlFor="waitlist-author-filter">Author</label>
          <input
            id="waitlist-author-filter"
            type="text"
            value={authorFilter}
            onChange={(e) => setAuthorFilter(e.target.value)}
          />
          <button type="submit">Filter</button>
        </form>

        {booksError ? <div role="alert">{booksError}</div> : null}

        {booksLoading ? (
          <p aria-live="polite">Loading titles…</p>
        ) : (
          <ul aria-label="Titles">
            {books.map((book) => (
              <li key={book._id}>
                <button
                  type="button"
                  onClick={() => handleSelectBook(book)}
                  aria-current={selectedBook?._id === book._id ? 'true' : undefined}
                >
                  {book.title} — {book.author} ({book.copiesAvailable} of {book.totalCopies} available)
                </button>
              </li>
            ))}
          </ul>
        )}

        {booksPagination && booksPagination.totalPages > 1 ? (
          <nav aria-label="Titles pagination">
            <button type="button" onClick={() => setBooksPage((p) => Math.max(1, p - 1))} disabled={booksPage <= 1}>
              Previous
            </button>
            <span aria-live="polite">
              Page {booksPagination.page} of {booksPagination.totalPages}
            </span>
            <button
              type="button"
              onClick={() => setBooksPage((p) => Math.min(booksPagination.totalPages, p + 1))}
              disabled={booksPage >= booksPagination.totalPages}
            >
              Next
            </button>
          </nav>
        ) : null}
      </section>

      {selectedBook ? (
        <section>
          <h2>Queue for {selectedBook.title}</h2>

          {queueError ? <div role="alert">{queueError}</div> : null}

          <button type="button" onClick={handleOfferNext} disabled={offering}>
            {offering ? 'Offering…' : 'Offer next in queue'}
          </button>

          {queueLoading ? (
            <p aria-live="polite">Loading queue…</p>
          ) : entries.length === 0 ? (
            <p>No one is currently waiting for this title.</p>
          ) : (
            <ol aria-label={`Waitlist queue for ${selectedBook.title}`}>
              {entries.map((entry) => {
                const action = entryAction[entry._id];
                const countdown = entry.status === 'offered' ? formatCountdown(entry.offerExpiresAt) : null;

                return (
                  <li key={entry._id}>
                    <p>
                      {entry.memberId?.name} ({entry.memberId?.email})
                    </p>
                    <p>
                      Position {entry.queuePosition} —{' '}
                      <Badge tone={entry.status === 'offered' ? 'warning' : 'info'}>
                        {entry.status === 'offered' ? 'Offered' : 'Waiting'}
                      </Badge>
                    </p>
                    {countdown ? <p>{countdown}</p> : null}
                    {action?.error ? <div role="alert">{action.error}</div> : null}
                    <button
                      type="button"
                      onClick={() => handleSkip(entry._id)}
                      disabled={action?.pending}
                      aria-label={`Skip ${entry.memberId?.name} for ${selectedBook.title}`}
                    >
                      {action?.pending ? 'Skipping…' : 'Skip'}
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      ) : null}
    </div>
  );
}
