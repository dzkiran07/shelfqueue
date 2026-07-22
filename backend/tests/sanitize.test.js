const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { sanitizeInput, sanitizeHtml } = require('../src/middleware/sanitize');
const loanController = require('../src/controllers/loan.controller');
const User = require('../src/models/User');
const Book = require('../src/models/Book');
const Loan = require('../src/models/Loan');

function runMiddleware(mw, req) {
  return new Promise((resolve, reject) => {
    const res = {};
    mw(req, res, (err) => (err ? reject(err) : resolve()));
  });
}

describe('sanitizeInput (NoSQL injection prevention)', () => {
  test('a {"$gt": ""} payload in a login-style field is neutralized', async () => {
    const req = {
      body: { email: 'a@example.com', password: { $gt: '' } },
      query: {},
      params: {},
    };

    await runMiddleware(sanitizeInput, req);

    // The $-prefixed operator key must not survive sanitization — whatever
    // is left can no longer be interpreted as a Mongo query operator.
    expect(req.body.password).not.toHaveProperty('$gt');
    expect(JSON.stringify(req.body)).not.toContain('$gt');
  });

  test('strips $ and . prefixed keys from query and params too', async () => {
    const req = {
      body: {},
      query: { '$where': 'sleep(1000)' },
      params: { 'user.role': 'librarian' },
    };

    await runMiddleware(sanitizeInput, req);

    expect(req.query).not.toHaveProperty('$where');
    expect(req.params).not.toHaveProperty('user.role');
  });

  test('leaves ordinary, non-malicious input untouched', async () => {
    const req = {
      body: { email: 'a@example.com', password: 'CorrectHorseBattery9!' },
      query: { genre: 'fiction' },
      params: { id: '507f1f77bcf86cd799439011' },
    };

    await runMiddleware(sanitizeInput, req);

    expect(req.body).toEqual({ email: 'a@example.com', password: 'CorrectHorseBattery9!' });
    expect(req.query).toEqual({ genre: 'fiction' });
    expect(req.params).toEqual({ id: '507f1f77bcf86cd799439011' });
  });
});

describe('sanitizeHtml (XSS prevention)', () => {
  test('strips a <script> tag and its content entirely', () => {
    const result = sanitizeHtml('<script>alert(1)</script>');
    expect(result).not.toContain('<script');
    expect(result).not.toContain('alert(1)');
  });

  test('strips event-handler-bearing tags entirely', () => {
    const result = sanitizeHtml('<img src=x onerror=alert(1)>');
    expect(result).not.toContain('onerror');
    expect(result).not.toContain('<img');
  });

  test('keeps plain text with no markup unchanged', () => {
    expect(sanitizeHtml('This book was great, thanks!')).toBe('This book was great, thanks!');
  });

  test('strips tags but preserves safe inner text', () => {
    expect(sanitizeHtml('Hello <b>world</b>')).toBe('Hello world');
  });

  test('passes through non-string input unchanged (caller\'s responsibility)', () => {
    expect(sanitizeHtml(undefined)).toBeUndefined();
    expect(sanitizeHtml(null)).toBeNull();
  });
});

describe('sanitizeHtml applied before saving a loan note', () => {
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
    await Promise.all([User.deleteMany({}), Book.deleteMany({}), Loan.deleteMany({})]);
  });

  test('a <script> payload submitted as a loan note is stripped before it reaches the database', async () => {
    const member = await User.create({
      name: 'Member',
      email: 'member@example.com',
      passwordHash: 'irrelevant-for-this-test',
      role: 'member',
    });
    const book = await Book.create({
      title: 'Test Book',
      author: 'Author',
      isbn: '000-0-00-000000-0',
      totalCopies: 1,
      copiesAvailable: 1,
    });
    const loan = await Loan.create({ bookId: book._id, memberId: member._id, status: 'requested' });

    const maliciousNote = "<script>document.title='XSS-'+document.cookie</script>";

    const req = {
      body: { memberNote: maliciousNote },
      resource: loan, // attached by requireOwnership in the real request pipeline
    };
    const res = {
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(body) {
        this.body = body;
        return this;
      },
    };

    await loanController.updateLoan(req, res, (err) => {
      throw err || new Error('updateLoan called next() unexpectedly');
    });

    // Re-fetch independently from the database — proves the sanitized
    // value is what actually persisted, not just what's held in memory.
    const persisted = await Loan.findById(loan._id);
    expect(persisted.memberNote).not.toContain('<script');
    expect(persisted.memberNote).not.toContain('document.cookie');
  });
});
