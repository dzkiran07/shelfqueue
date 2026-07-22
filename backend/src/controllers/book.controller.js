const { z } = require('zod');
const Book = require('../models/Book');
const { sanitizeHtml } = require('../middleware/sanitize');
const { logActivity } = require('../middleware/auditLogger');

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// .strict() on both schemas: status/createdBy/_id are never accepted from
// the request body even though this endpoint is already librarian-only —
// status is server-controlled (defaults 'active' on create, only changes
// via retire), and createdBy is always derived from req.user, never
// client-supplied. Defense in depth beats relying solely on RBAC.
const bookCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(300),
    author: z.string().trim().min(1).max(200),
    isbn: z.string().trim().min(1).max(30),
    genre: z.string().trim().max(100).optional(),
    description: z.string().max(5000).optional(),
    coverUrl: z.string().trim().url().max(2000).optional(),
    totalCopies: z.number().int().min(0),
    copiesAvailable: z.number().int().min(0).optional(),
  })
  .strict()
  .refine((data) => data.copiesAvailable === undefined || data.copiesAvailable <= data.totalCopies, {
    message: 'copiesAvailable cannot exceed totalCopies',
    path: ['copiesAvailable'],
  });

const bookUpdateSchema = z
  .object({
    title: z.string().trim().min(1).max(300).optional(),
    author: z.string().trim().min(1).max(200).optional(),
    isbn: z.string().trim().min(1).max(30).optional(),
    genre: z.string().trim().max(100).optional(),
    description: z.string().max(5000).optional(),
    coverUrl: z.string().trim().url().max(2000).optional(),
    totalCopies: z.number().int().min(0).optional(),
    copiesAvailable: z.number().int().min(0).optional(),
  })
  .strict();

function formatZodError(error) {
  return {
    error: 'Invalid book data',
    details: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  };
}

async function listBooks(req, res, next) {
  try {
    const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || DEFAULT_PAGE_LIMIT, 1), MAX_PAGE_LIMIT);

    const filter = {};

    // Partial, case-insensitive match on genre/author. User input is
    // regex-escaped before being used to build the RegExp so it can't
    // inject unintended regex syntax — NoSQL operator injection itself
    // (e.g. a raw $gt/$where object) is already stopped upstream by the
    // global sanitizeInput middleware (Phase 13), which strips $/.
    // prefixed keys from req.query before this handler ever sees it.
    if (typeof req.query.genre === 'string' && req.query.genre.trim()) {
      filter.genre = new RegExp(escapeRegex(req.query.genre.trim()), 'i');
    }
    if (typeof req.query.author === 'string' && req.query.author.trim()) {
      filter.author = new RegExp(escapeRegex(req.query.author.trim()), 'i');
    }

    if (req.query.status === 'active' || req.query.status === 'retired') {
      filter.status = req.query.status;
    } else if (req.query.status !== 'all') {
      // Default view (no/invalid status filter) shows only active titles —
      // retired ones aren't meant to surface in ordinary catalog browsing.
      // Pass ?status=all to see both, e.g. for a librarian's catalog
      // manager view.
      filter.status = 'active';
    }

    const [books, total] = await Promise.all([
      Book.find(filter)
        .sort({ title: 1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Book.countDocuments(filter),
    ]);

    return res.status(200).json({
      books,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  } catch (err) {
    return next(err);
  }
}

async function getBook(req, res, next) {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }
    return res.status(200).json({ book });
  } catch (err) {
    if (err.name === 'CastError') {
      return res.status(404).json({ error: 'Book not found' });
    }
    return next(err);
  }
}

async function createBook(req, res, next) {
  const parsed = bookCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(formatZodError(parsed.error));
  }

  try {
    const data = parsed.data;
    const totalCopies = data.totalCopies;
    // Defaults to fully available on creation if the caller doesn't
    // specify otherwise — a freshly added title has no copies checked out
    // yet.
    const copiesAvailable = data.copiesAvailable ?? totalCopies;

    const book = await Book.create({
      title: data.title,
      author: data.author,
      isbn: data.isbn,
      genre: data.genre,
      description: data.description !== undefined ? sanitizeHtml(data.description) : undefined,
      coverUrl: data.coverUrl,
      totalCopies,
      copiesAvailable,
      status: 'active',
      createdBy: req.user._id,
    });

    await logActivity({
      actorId: req.user._id,
      action: 'book_created',
      resourceType: 'Book',
      resourceId: book._id,
      req,
    });

    return res.status(201).json({ book });
  } catch (err) {
    return next(err);
  }
}

async function updateBook(req, res, next) {
  const parsed = bookUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json(formatZodError(parsed.error));
  }

  try {
    const book = await Book.findById(req.params.id);
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    const data = parsed.data;

    // Partial updates mean either field can be omitted, so the
    // copiesAvailable <= totalCopies invariant has to be checked against
    // the MERGED result (incoming values layered over what's already
    // stored), not just whatever happens to be present in this request.
    const effectiveTotalCopies = data.totalCopies !== undefined ? data.totalCopies : book.totalCopies;
    const effectiveCopiesAvailable =
      data.copiesAvailable !== undefined ? data.copiesAvailable : book.copiesAvailable;

    if (effectiveCopiesAvailable > effectiveTotalCopies) {
      return res.status(400).json({ error: 'copiesAvailable cannot exceed totalCopies' });
    }

    if (data.title !== undefined) book.title = data.title;
    if (data.author !== undefined) book.author = data.author;
    if (data.isbn !== undefined) book.isbn = data.isbn;
    if (data.genre !== undefined) book.genre = data.genre;
    if (data.description !== undefined) book.description = sanitizeHtml(data.description);
    if (data.coverUrl !== undefined) book.coverUrl = data.coverUrl;
    if (data.totalCopies !== undefined) book.totalCopies = data.totalCopies;
    if (data.copiesAvailable !== undefined) book.copiesAvailable = data.copiesAvailable;

    await book.save();

    await logActivity({
      actorId: req.user._id,
      action: 'book_updated',
      resourceType: 'Book',
      resourceId: book._id,
      req,
    });

    return res.status(200).json({ book });
  } catch (err) {
    if (err.name === 'CastError') {
      return res.status(404).json({ error: 'Book not found' });
    }
    return next(err);
  }
}

async function deleteBook(req, res, next) {
  try {
    const book = await Book.findById(req.params.id);
    if (!book) {
      return res.status(404).json({ error: 'Book not found' });
    }

    // Soft-delete: flip to 'retired' rather than removing the document.
    // Loan documents reference bookId, and loan history is a library-owned
    // record that should outlive a title being pulled from circulation —
    // a hard delete would either orphan that history or force a cascading
    // delete this app has no reason to want.
    book.status = 'retired';
    await book.save();

    await logActivity({
      actorId: req.user._id,
      action: 'book_retired',
      resourceType: 'Book',
      resourceId: book._id,
      req,
    });

    return res.status(200).json({ book });
  } catch (err) {
    if (err.name === 'CastError') {
      return res.status(404).json({ error: 'Book not found' });
    }
    return next(err);
  }
}

module.exports = { listBooks, getBook, createBook, updateBook, deleteBook };
