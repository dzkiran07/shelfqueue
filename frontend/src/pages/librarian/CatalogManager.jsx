import { useCallback, useEffect, useState } from 'react';
import axiosClient from '../../api/axiosClient';
import Badge from '../../components/ui/Badge.jsx';

const EMPTY_FORM = {
  title: '',
  author: '',
  isbn: '',
  genre: '',
  description: '',
  coverUrl: '',
  totalCopies: 1,
  copiesAvailable: 1,
};

export default function CatalogManager() {
  const [books, setBooks] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState('all');
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState(null);

  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formErrors, setFormErrors] = useState([]);
  const [saving, setSaving] = useState(false);

  const [retiring, setRetiring] = useState({});

  const loadBooks = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const { data } = await axiosClient.get('/api/books', { params: { status: statusFilter, page } });
      setBooks(data.books);
      setPagination(data.pagination);
    } catch (err) {
      setListError(err.response?.data?.error || 'Could not load the catalog.');
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    loadBooks();
  }, [loadBooks]);

  function updateField(field, value) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function startEdit(book) {
    setEditingId(book._id);
    setForm({
      title: book.title,
      author: book.author,
      isbn: book.isbn,
      genre: book.genre || '',
      description: book.description || '',
      coverUrl: book.coverUrl || '',
      totalCopies: book.totalCopies,
      copiesAvailable: book.copiesAvailable,
    });
    setFormErrors([]);
  }

  function cancelEdit() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setFormErrors([]);
  }

  function buildPayload() {
    const payload = {
      title: form.title.trim(),
      author: form.author.trim(),
      isbn: form.isbn.trim(),
      totalCopies: Number(form.totalCopies),
      copiesAvailable: Number(form.copiesAvailable),
    };
    if (form.genre.trim()) payload.genre = form.genre.trim();
    if (form.description.trim()) payload.description = form.description.trim();
    if (form.coverUrl.trim()) payload.coverUrl = form.coverUrl.trim();
    return payload;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFormErrors([]);
    setSaving(true);
    try {
      const payload = buildPayload();
      if (editingId) {
        await axiosClient.patch(`/api/books/${editingId}`, payload);
      } else {
        await axiosClient.post('/api/books', payload);
      }
      cancelEdit();
      await loadBooks();
    } catch (err) {
      const data = err.response?.data;
      const messages = data?.details
        ? data.details.map((d) => `${d.path}: ${d.message}`)
        : [data?.error || 'Could not save this title. Please try again.'];
      setFormErrors(messages);
    } finally {
      setSaving(false);
    }
  }

  async function handleRetire(bookId) {
    setRetiring((prev) => ({ ...prev, [bookId]: true }));
    try {
      await axiosClient.delete(`/api/books/${bookId}`);
      await loadBooks();
    } catch (err) {
      setListError(err.response?.data?.error || 'Could not retire this title.');
    } finally {
      setRetiring((prev) => ({ ...prev, [bookId]: false }));
    }
  }

  return (
    <div>
      <h1>Catalog manager</h1>

      <section>
        <h2>{editingId ? 'Edit title' : 'Add a title'}</h2>

        {formErrors.length > 0 ? (
          <div role="alert" id="catalog-form-errors">
            <ul>
              {formErrors.map((msg) => (
                <li key={msg}>{msg}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <form onSubmit={handleSubmit} noValidate>
          <div>
            <label htmlFor="book-title">Title</label>
            <input
              id="book-title"
              type="text"
              required
              value={form.title}
              onChange={(e) => updateField('title', e.target.value)}
              aria-describedby={formErrors.length ? 'catalog-form-errors' : undefined}
            />
          </div>

          <div>
            <label htmlFor="book-author">Author</label>
            <input
              id="book-author"
              type="text"
              required
              value={form.author}
              onChange={(e) => updateField('author', e.target.value)}
              aria-describedby={formErrors.length ? 'catalog-form-errors' : undefined}
            />
          </div>

          <div>
            <label htmlFor="book-isbn">ISBN</label>
            <input
              id="book-isbn"
              type="text"
              required
              value={form.isbn}
              onChange={(e) => updateField('isbn', e.target.value)}
              aria-describedby={formErrors.length ? 'catalog-form-errors' : undefined}
            />
          </div>

          <div>
            <label htmlFor="book-genre">Genre</label>
            <input id="book-genre" type="text" value={form.genre} onChange={(e) => updateField('genre', e.target.value)} />
          </div>

          <div>
            <label htmlFor="book-description">Description</label>
            <textarea
              id="book-description"
              value={form.description}
              onChange={(e) => updateField('description', e.target.value)}
            />
          </div>

          <div>
            <label htmlFor="book-cover-url">Cover image URL</label>
            <input
              id="book-cover-url"
              type="url"
              value={form.coverUrl}
              onChange={(e) => updateField('coverUrl', e.target.value)}
            />
          </div>

          <div>
            <label htmlFor="book-total-copies">Total copies</label>
            <input
              id="book-total-copies"
              type="number"
              min="0"
              required
              value={form.totalCopies}
              onChange={(e) => updateField('totalCopies', e.target.value)}
              aria-describedby={formErrors.length ? 'catalog-form-errors' : undefined}
            />
          </div>

          <div>
            <label htmlFor="book-copies-available">Copies available</label>
            <input
              id="book-copies-available"
              type="number"
              min="0"
              required
              value={form.copiesAvailable}
              onChange={(e) => updateField('copiesAvailable', e.target.value)}
              aria-describedby={formErrors.length ? 'catalog-form-errors' : undefined}
            />
          </div>

          <button type="submit" disabled={saving}>
            {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add title'}
          </button>
          {editingId ? (
            <button type="button" onClick={cancelEdit} disabled={saving}>
              Cancel
            </button>
          ) : null}
        </form>
      </section>

      <section>
        <h2>Titles</h2>

        <div>
          <label htmlFor="catalog-status-filter">Show</label>
          <select
            id="catalog-status-filter"
            value={statusFilter}
            onChange={(e) => {
              setPage(1);
              setStatusFilter(e.target.value);
            }}
          >
            <option value="all">All</option>
            <option value="active">Active</option>
            <option value="retired">Retired</option>
          </select>
        </div>

        {listError ? <div role="alert">{listError}</div> : null}

        {loading ? (
          <p aria-live="polite">Loading titles…</p>
        ) : books.length === 0 ? (
          <p>No titles found.</p>
        ) : (
          <table>
            <caption>Catalog titles</caption>
            <thead>
              <tr>
                <th scope="col">Title</th>
                <th scope="col">Author</th>
                <th scope="col">Copies</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {books.map((book) => (
                <tr key={book._id}>
                  <td>{book.title}</td>
                  <td>{book.author}</td>
                  <td>
                    {book.copiesAvailable} / {book.totalCopies}
                  </td>
                  <td>
                    <Badge tone={book.status === 'active' ? 'success' : 'neutral'}>{book.status}</Badge>
                  </td>
                  <td>
                    <button type="button" onClick={() => startEdit(book)} aria-label={`Edit ${book.title}`}>
                      Edit {book.title}
                    </button>
                    {book.status === 'active' ? (
                      <button
                        type="button"
                        onClick={() => handleRetire(book._id)}
                        disabled={retiring[book._id]}
                        aria-label={`Retire ${book.title}`}
                      >
                        {retiring[book._id] ? 'Retiring…' : `Retire ${book.title}`}
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {pagination && pagination.totalPages > 1 ? (
          <nav aria-label="Catalog manager pagination">
            <button type="button" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              Previous
            </button>
            <span aria-live="polite">
              Page {pagination.page} of {pagination.totalPages}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
              disabled={page >= pagination.totalPages}
            >
              Next
            </button>
          </nav>
        ) : null}
      </section>
    </div>
  );
}
