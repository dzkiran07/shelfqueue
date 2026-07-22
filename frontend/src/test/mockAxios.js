import { vi } from 'vitest';

// Sample data shared by every page's axe test — deep enough to exercise
// list rendering, badges and tables, shallow enough to stay readable.
export const sampleBook = {
  _id: 'book-1',
  title: 'The Pragmatic Programmer',
  author: 'David Thomas',
  genre: 'Software',
  description: 'A classic.',
  isbn: '9780135957059',
  coverUrl: '',
  totalCopies: 3,
  copiesAvailable: 2,
  status: 'active',
};

export const soldOutBook = {
  ...sampleBook,
  _id: 'book-2',
  title: 'Structure and Interpretation of Computer Programs',
  copiesAvailable: 0,
};

export const sampleLoan = {
  _id: 'loan-1',
  bookId: { title: sampleBook.title, author: sampleBook.author },
  memberId: { name: 'Ada Lovelace', email: 'ada@example.com' },
  status: 'requested',
  requestedAt: '2026-01-01T00:00:00.000Z',
  dueDate: null,
  memberNote: 'Please hold at the front desk.',
};

export const sampleWaitlistEntry = {
  _id: 'wl-1',
  bookId: { title: sampleBook.title, author: sampleBook.author },
  status: 'waiting',
  queuePosition: 2,
  offerExpiresAt: null,
};

export const sampleSession = {
  id: 'session-1',
  userAgent: 'Mozilla/5.0 (test runner)',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastUsedAt: '2026-01-02T00:00:00.000Z',
};

export const sampleAuditLog = {
  _id: 'log-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  action: 'login_success',
  resourceType: 'user',
  resourceId: 'user-1',
  actorId: 'user-1',
  ip: '127.0.0.1',
};

export const sampleUser = (role = 'member') => ({
  id: 'user-1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  role,
  phone: '',
  notificationPreferences: { email: true },
  mfaEnabled: false,
  oauthProviders: [],
});

const paginationFor = (items) => ({ page: 1, totalPages: 1, total: items.length });

// Maps request paths to fixture responses; falls back to an empty-but-valid
// shape so any endpoint a test doesn't care about still resolves cleanly
// instead of leaving the page stuck on its loading state.
export function buildAxiosMock({ role = 'member' } = {}) {
  const get = vi.fn((url) => {
    if (url.startsWith('/api/auth/me')) return Promise.resolve({ data: { user: sampleUser(role) } });
    if (url.startsWith('/api/csrf-token')) return Promise.resolve({ data: { csrfToken: 'test-csrf-token' } });
    if (url.startsWith('/api/books/')) return Promise.resolve({ data: { book: sampleBook } });
    if (url.startsWith('/api/books')) {
      return Promise.resolve({ data: { books: [sampleBook, soldOutBook], pagination: paginationFor([sampleBook, soldOutBook]) } });
    }
    if (url.startsWith('/api/loans/me')) return Promise.resolve({ data: { loans: [sampleLoan] } });
    if (url.startsWith('/api/waitlist/me')) return Promise.resolve({ data: { waitlist: [sampleWaitlistEntry] } });
    if (url.startsWith('/api/users/me')) return Promise.resolve({ data: { user: sampleUser(role) } });
    if (url.startsWith('/api/auth/sessions')) return Promise.resolve({ data: { sessions: [sampleSession] } });
    if (url.startsWith('/api/admin/loans')) return Promise.resolve({ data: { loans: [sampleLoan], pagination: paginationFor([sampleLoan]) } });
    if (url.startsWith('/api/admin/alerts')) return Promise.resolve({ data: { alerts: [] } });
    if (url.startsWith('/api/admin/audit-logs')) {
      return Promise.resolve({ data: { logs: [sampleAuditLog], pagination: paginationFor([sampleAuditLog]) } });
    }
    if (url.startsWith('/api/admin/waitlist')) return Promise.resolve({ data: { waitlist: [sampleWaitlistEntry] } });
    return Promise.resolve({ data: {} });
  });

  const post = vi.fn(() => Promise.resolve({ data: {} }));
  const patch = vi.fn(() => Promise.resolve({ data: {} }));
  const del = vi.fn(() => Promise.resolve({ data: {} }));

  return { get, post, patch, delete: del };
}
