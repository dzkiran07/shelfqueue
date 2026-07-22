const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../src/models/User');
const Book = require('../src/models/Book');
const bookController = require('../src/controllers/book.controller');

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await Promise.all([User.deleteMany({}), Book.deleteMany({})]);
});

function makeRes() {
  const res = {};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

async function createLibrarian() {
  return User.create({
    name: 'Librarian',
    email: `lib-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'irrelevant-for-this-test',
    role: 'librarian',
  });
}

// Includes copiesAvailable so this doubles as a valid Mongoose seed
// document for tests that call Book.create() directly (bypassing the
// controller's default-to-totalCopies logic, which is tested separately
// and explicitly below).
function validBookPayload(overrides = {}) {
  return {
    title: 'The Pragmatic Programmer',
    author: 'David Thomas',
    isbn: '978-0135957059',
    genre: 'Software Engineering',
    totalCopies: 3,
    copiesAvailable: 3,
    ...overrides,
  };
}

describe('POST /api/books (create)', () => {
  test('a librarian can create a book with valid data, defaulting copiesAvailable to totalCopies', async () => {
    const librarian = await createLibrarian();
    const payload = validBookPayload();
    delete payload.copiesAvailable; // deliberately omitted to exercise the default
    const req = { user: librarian, body: payload };
    const res = makeRes();

    await bookController.createBook(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.book.title).toBe('The Pragmatic Programmer');
    expect(res.body.book.status).toBe('active');
    expect(res.body.book.copiesAvailable).toBe(3); // defaults to totalCopies
    expect(String(res.body.book.createdBy)).toBe(String(librarian._id));
  });

  test('rejects missing title/author/isbn', async () => {
    const librarian = await createLibrarian();
    const req = { user: librarian, body: { totalCopies: 1 } };
    const res = makeRes();

    await bookController.createBook(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(400);
    const paths = res.body.details.map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['title', 'author', 'isbn']));
  });

  test('rejects a negative totalCopies', async () => {
    const librarian = await createLibrarian();
    const req = { user: librarian, body: validBookPayload({ totalCopies: -1 }) };
    const res = makeRes();

    await bookController.createBook(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(400);
  });

  test('rejects copiesAvailable greater than totalCopies', async () => {
    const librarian = await createLibrarian();
    const req = {
      user: librarian,
      body: validBookPayload({ totalCopies: 2, copiesAvailable: 5 }),
    };
    const res = makeRes();

    await bookController.createBook(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(400);
  });

  test('sanitizes a <script> payload in the description before saving', async () => {
    const librarian = await createLibrarian();
    const req = {
      user: librarian,
      body: validBookPayload({ description: "<script>alert('xss')</script>Great book" }),
    };
    const res = makeRes();

    await bookController.createBook(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(201);
    const persisted = await Book.findById(res.body.book._id);
    expect(persisted.description).not.toContain('<script');
    expect(persisted.description).toContain('Great book');
  });

  test('rejects an attempt to set status or createdBy directly via the body', async () => {
    const librarian = await createLibrarian();
    const req = {
      user: librarian,
      body: validBookPayload({ status: 'retired', createdBy: '000000000000000000000000' }),
    };
    const res = makeRes();

    await bookController.createBook(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(400);
  });

  test('rejects an invalid coverUrl', async () => {
    const librarian = await createLibrarian();
    const req = { user: librarian, body: validBookPayload({ coverUrl: 'not-a-url' }) };
    const res = makeRes();

    await bookController.createBook(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('PATCH /api/books/:id (update)', () => {
  test('a partial update merges against the existing document for the copiesAvailable<=totalCopies check', async () => {
    const librarian = await createLibrarian();
    const book = await Book.create({ ...validBookPayload(), totalCopies: 5, copiesAvailable: 5, createdBy: librarian._id });

    // Attempt to raise copiesAvailable above the EXISTING totalCopies
    // without also raising totalCopies in the same request.
    const req = { params: { id: String(book._id) }, body: { copiesAvailable: 10 } };
    const res = makeRes();

    await bookController.updateBook(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(400);
  });

  test('a valid partial update succeeds and other fields are untouched', async () => {
    const librarian = await createLibrarian();
    const book = await Book.create({ ...validBookPayload(), createdBy: librarian._id });

    const req = { user: librarian, params: { id: String(book._id) }, body: { genre: 'Updated Genre' } };
    const res = makeRes();

    await bookController.updateBook(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.book.genre).toBe('Updated Genre');
    expect(res.body.book.title).toBe('The Pragmatic Programmer');
  });

  test('sanitizes a <script> payload in the description on update too (not just create)', async () => {
    const librarian = await createLibrarian();
    const book = await Book.create({ ...validBookPayload(), createdBy: librarian._id });

    const req = {
      user: librarian,
      params: { id: String(book._id) },
      body: { description: '<script>document.cookie</script>' },
    };
    const res = makeRes();

    await bookController.updateBook(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(200);
    const persisted = await Book.findById(book._id);
    expect(persisted.description).not.toContain('<script');
  });

  test('404s for a nonexistent book', async () => {
    const req = { params: { id: new mongoose.Types.ObjectId().toString() }, body: { genre: 'X' } };
    const res = makeRes();

    await bookController.updateBook(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(404);
  });

  test('404s (not 500) for a malformed id', async () => {
    const req = { params: { id: 'not-a-valid-id' }, body: { genre: 'X' } };
    const res = makeRes();

    await bookController.updateBook(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/books/:id (retire)', () => {
  test('soft-deletes: flips status to retired rather than removing the document', async () => {
    const librarian = await createLibrarian();
    const book = await Book.create({ ...validBookPayload(), createdBy: librarian._id });

    const req = { user: librarian, params: { id: String(book._id) } };
    const res = makeRes();

    await bookController.deleteBook(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(200);
    const persisted = await Book.findById(book._id);
    expect(persisted).not.toBeNull();
    expect(persisted.status).toBe('retired');
  });

  test('404s for a nonexistent book', async () => {
    const req = { params: { id: new mongoose.Types.ObjectId().toString() } };
    const res = makeRes();

    await bookController.deleteBook(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/books (list, pagination, filters)', () => {
  beforeEach(async () => {
    const librarian = await createLibrarian();
    await Book.create([
      { title: 'Clean Code', author: 'Robert Martin', genre: 'Software', isbn: '1', totalCopies: 2, copiesAvailable: 2, createdBy: librarian._id },
      { title: 'The Hobbit', author: 'J.R.R. Tolkien', genre: 'Fantasy', isbn: '2', totalCopies: 1, copiesAvailable: 1, createdBy: librarian._id },
      { title: 'Refactoring', author: 'Martin Fowler', genre: 'Software', isbn: '3', totalCopies: 1, copiesAvailable: 0, createdBy: librarian._id, status: 'retired' },
    ]);
  });

  test('defaults to active-only results', async () => {
    const req = { query: {} };
    const res = makeRes();
    await bookController.listBooks(req, res, (err) => { throw err; });

    expect(res.body.books).toHaveLength(2);
    expect(res.body.books.every((b) => b.status === 'active')).toBe(true);
  });

  test('status=all includes retired titles too', async () => {
    const req = { query: { status: 'all' } };
    const res = makeRes();
    await bookController.listBooks(req, res, (err) => { throw err; });

    expect(res.body.books).toHaveLength(3);
  });

  test('filters by genre (case-insensitive partial match)', async () => {
    const req = { query: { genre: 'software' } };
    const res = makeRes();
    await bookController.listBooks(req, res, (err) => { throw err; });

    expect(res.body.books).toHaveLength(1); // Refactoring is retired, excluded by default
    expect(res.body.books[0].title).toBe('Clean Code');
  });

  test('filters by author (case-insensitive partial match)', async () => {
    const req = { query: { author: 'tolkien' } };
    const res = makeRes();
    await bookController.listBooks(req, res, (err) => { throw err; });

    expect(res.body.books).toHaveLength(1);
    expect(res.body.books[0].title).toBe('The Hobbit');
  });

  test('a regex-special-character author filter does not throw (safely escaped)', async () => {
    const req = { query: { author: '(evil' } };
    const res = makeRes();

    await expect(
      bookController.listBooks(req, res, (err) => { throw err; })
    ).resolves.not.toThrow();
    expect(res.body.books).toHaveLength(0);
  });

  test('pagination respects page and limit', async () => {
    const req = { query: { status: 'all', limit: '1', page: '2' } };
    const res = makeRes();
    await bookController.listBooks(req, res, (err) => { throw err; });

    expect(res.body.books).toHaveLength(1);
    expect(res.body.pagination).toEqual({ page: 2, limit: 1, total: 3, totalPages: 3 });
  });
});

describe('GET /api/books/:id', () => {
  test('returns a single book by id', async () => {
    const librarian = await createLibrarian();
    const book = await Book.create({ ...validBookPayload(), createdBy: librarian._id });

    const req = { params: { id: String(book._id) } };
    const res = makeRes();
    await bookController.getBook(req, res, (err) => { throw err; });

    expect(res.statusCode).toBe(200);
    expect(res.body.book.title).toBe('The Pragmatic Programmer');
  });

  test('404s for a nonexistent id', async () => {
    const req = { params: { id: new mongoose.Types.ObjectId().toString() } };
    const res = makeRes();
    await bookController.getBook(req, res, (err) => { throw err; });

    expect(res.statusCode).toBe(404);
  });

  test('404s (not 500) for a malformed id', async () => {
    const req = { params: { id: 'garbage' } };
    const res = makeRes();
    await bookController.getBook(req, res, (err) => { throw err; });

    expect(res.statusCode).toBe(404);
  });
});
