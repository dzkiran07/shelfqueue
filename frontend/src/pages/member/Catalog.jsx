import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import axiosClient from '../../api/axiosClient';
import Badge from '../../components/ui/Badge.jsx';

export default function Catalog() {
  const [author, setAuthor] = useState('');
  const [genre, setGenre] = useState('');
  const [appliedFilters, setAppliedFilters] = useState({ author: '', genre: '' });
  const [page, setPage] = useState(1);

  const [books, setBooks] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [waitlistStatus, setWaitlistStatus] = useState({});

  const loadBooks = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await axiosClient.get('/api/books', {
        params: {
          page,
          ...(appliedFilters.author ? { author: appliedFilters.author } : {}),
          ...(appliedFilters.genre ? { genre: appliedFilters.genre } : {}),
        },
      });
      setBooks(data.books);
      setPagination(data.pagination);
    } catch (err) {
      setError(err.response?.data?.error || 'Could not load the catalog. Please try again.');
    } finally {
      setLoading(false);
    }
  }, [page, appliedFilters]);

  useEffect(() => {
    loadBooks();
  }, [loadBooks]);

  function handleSearchSubmit(e) {
    e.preventDefault();
    setPage(1);
    setAppliedFilters({ author, genre });
  }

  function handleClearFilters() {
    setAuthor('');
    setGenre('');
    setPage(1);
    setAppliedFilters({ author: '', genre: '' });
  }

  async function handleJoinWaitlist(bookId) {
    setWaitlistStatus((prev) => ({ ...prev, [bookId]: { pending: true } }));
    try {
      await axiosClient.post('/api/waitlist', { bookId });
      setWaitlistStatus((prev) => ({
        ...prev,
        [bookId]: { pending: false, ok: true, message: 'Added to the waitlist for this title.' },
      }));
    } catch (err) {
      setWaitlistStatus((prev) => ({
        ...prev,
        [bookId]: {
          pending: false,
          ok: false,
          message: err.response?.data?.error || 'Could not join the waitlist. Please try again.',
        },
      }));
    }
  }

  return (
    <div>
      <h1>Catalog</h1>

      <form onSubmit={handleSearchSubmit} role="search" aria-label="Search the catalog" noValidate>
        <div>
          <label htmlFor="catalog-author">Author</label>
          <input
            id="catalog-author"
            name="author"
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </div>
        <div>
          <label htmlFor="catalog-genre">Genre</label>
          <input
            id="catalog-genre"
            name="genre"
            type="text"
            value={genre}
            onChange={(e) => setGenre(e.target.value)}
          />
        </div>
        <button type="submit">Search</button>
        <button type="button" onClick={handleClearFilters}>
          Clear filters
        </button>
      </form>

      {error ? (
        <div role="alert" id="catalog-error">
          {error}
        </div>
      ) : null}

      {loading ? (
        <p aria-live="polite">Loading catalog…</p>
      ) : (
        <>
          {books.length === 0 ? (
            <p>No titles match your search.</p>
          ) : (
            <ul aria-label="Books">
              {books.map((book) => {
                const status = waitlistStatus[book._id];
                const available = book.copiesAvailable > 0;

                return (
                  <li key={book._id}>
                    <h2>{book.title}</h2>
                    <p>{book.author}</p>
                    {book.genre ? <p>{book.genre}</p> : null}

                    {available ? (
                      <>
                        <p>
                          <Badge tone="success">
                            Available ({book.copiesAvailable} of {book.totalCopies})
                          </Badge>
                        </p>
                        <Link to={`/loans/new?bookId=${book._id}`}>
                          Request loan for {book.title}
                        </Link>
                      </>
                    ) : (
                      <>
                        <p>
                          <Badge tone="warning">All copies checked out</Badge>
                        </p>
                        <button
                          type="button"
                          onClick={() => handleJoinWaitlist(book._id)}
                          disabled={status?.pending || status?.ok}
                          aria-describedby={status ? `waitlist-status-${book._id}` : undefined}
                        >
                          {status?.ok
                            ? 'On waitlist'
                            : status?.pending
                              ? 'Joining…'
                              : `Join waitlist for ${book.title}`}
                        </button>
                        {status ? (
                          <div role={status.ok ? 'status' : 'alert'} id={`waitlist-status-${book._id}`}>
                            {status.message}
                          </div>
                        ) : null}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          )}

          {pagination && pagination.totalPages > 1 ? (
            <nav aria-label="Catalog pagination">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={pagination.page <= 1}
              >
                Previous
              </button>
              <span aria-live="polite">
                Page {pagination.page} of {pagination.totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
                disabled={pagination.page >= pagination.totalPages}
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      )}
    </div>
  );
}
