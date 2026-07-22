const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../src/models/User');
const Book = require('../src/models/Book');
const Loan = require('../src/models/Loan');
const Waitlist = require('../src/models/Waitlist');
const AuditLog = require('../src/models/AuditLog');
const loanController = require('../src/controllers/loan.controller');
const loanService = require('../src/services/loanService');
const env = require('../src/config/env');

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
  await Promise.all([
    User.deleteMany({}),
    Book.deleteMany({}),
    Loan.deleteMany({}),
    Waitlist.deleteMany({}),
    AuditLog.deleteMany({}),
  ]);
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

async function createMember(overrides = {}) {
  return User.create({
    name: 'Member',
    email: `member-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'irrelevant-for-this-test',
    role: 'member',
    ...overrides,
  });
}

async function createLibrarian(overrides = {}) {
  return User.create({
    name: 'Librarian',
    email: `lib-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'irrelevant-for-this-test',
    role: 'librarian',
    ...overrides,
  });
}

async function createBook(overrides = {}) {
  return Book.create({
    title: 'Test Book',
    author: 'Test Author',
    isbn: '000-0-00-000000-0',
    totalCopies: 1,
    copiesAvailable: 1,
    ...overrides,
  });
}

describe('POST /api/loans (createLoan)', () => {
  test('creates a loan and decrements copiesAvailable when a copy is free', async () => {
    const member = await createMember();
    const book = await createBook({ copiesAvailable: 3, totalCopies: 3 });

    const req = { user: member, body: { bookId: String(book._id) } };
    const res = makeRes();

    await loanController.createLoan(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(201);
    expect(res.body.loan.status).toBe('requested');
    expect(res.body.loan.dueDate).toBeUndefined(); // not computed until approval (Phase 20)
    expect(String(res.body.loan.memberId)).toBe(String(member._id));

    const reloadedBook = await Book.findById(book._id);
    expect(reloadedBook.copiesAvailable).toBe(2);
  });

  test('sanitizes a <script> payload in an optional memberNote submitted at request time', async () => {
    const member = await createMember();
    const book = await createBook();

    const req = {
      user: member,
      body: { bookId: String(book._id), memberNote: '<script>alert(1)</script>please rush' },
    };
    const res = makeRes();

    await loanController.createLoan(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(201);
    const persisted = await Loan.findById(res.body.loan._id);
    expect(persisted.memberNote).not.toContain('<script');
    expect(persisted.memberNote).toContain('please rush');
  });

  test('rejects with 409 and joinWaitlist:true when no copies are available', async () => {
    const member = await createMember();
    const book = await createBook({ copiesAvailable: 0, totalCopies: 1 });

    const req = { user: member, body: { bookId: String(book._id) } };
    const res = makeRes();

    await loanController.createLoan(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(409);
    expect(res.body.joinWaitlist).toBe(true);

    const loans = await Loan.find({ bookId: book._id });
    expect(loans).toHaveLength(0);
  });

  test('rejects a retired title with 400, even if it still has copiesAvailable > 0', async () => {
    const member = await createMember();
    const book = await createBook({ status: 'retired', copiesAvailable: 5, totalCopies: 5 });

    const req = { user: member, body: { bookId: String(book._id) } };
    const res = makeRes();

    await loanController.createLoan(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(400);
    const reloadedBook = await Book.findById(book._id);
    expect(reloadedBook.copiesAvailable).toBe(5); // untouched
  });

  test('404s for a nonexistent bookId', async () => {
    const member = await createMember();
    const req = { user: member, body: { bookId: new mongoose.Types.ObjectId().toString() } };
    const res = makeRes();

    await loanController.createLoan(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(404);
  });

  test('400s for a missing or malformed bookId', async () => {
    const member = await createMember();

    const resMissing = makeRes();
    await loanController.createLoan({ user: member, body: {} }, resMissing, (err) => {
      throw err || new Error('unexpected next() call');
    });
    expect(resMissing.statusCode).toBe(400);

    const resMalformed = makeRes();
    await loanController.createLoan(
      { user: member, body: { bookId: 'not-an-object-id' } },
      resMalformed,
      (err) => {
        throw err || new Error('unexpected next() call');
      }
    );
    expect(resMalformed.statusCode).toBe(400);
  });

  test('race condition: two concurrent requests for the last available copy — only one succeeds', async () => {
    const memberA = await createMember();
    const memberB = await createMember();
    const book = await createBook({ copiesAvailable: 1, totalCopies: 1 });

    const reqA = { user: memberA, body: { bookId: String(book._id) } };
    const reqB = { user: memberB, body: { bookId: String(book._id) } };
    const resA = makeRes();
    const resB = makeRes();

    // Fired concurrently on purpose — this is the actual scenario under
    // test: both requests racing to claim the same last copy against a
    // real (in-memory) MongoDB instance, not a mocked/serialized call.
    await Promise.all([
      loanController.createLoan(reqA, resA, (err) => {
        throw err || new Error('unexpected next() call (A)');
      }),
      loanController.createLoan(reqB, resB, (err) => {
        throw err || new Error('unexpected next() call (B)');
      }),
    ]);

    const statuses = [resA.statusCode, resB.statusCode].sort();
    expect(statuses).toEqual([201, 409]);

    const finalBook = await Book.findById(book._id);
    expect(finalBook.copiesAvailable).toBe(0);

    const loans = await Loan.find({ bookId: book._id });
    expect(loans).toHaveLength(1);

    const winner = resA.statusCode === 201 ? memberA : memberB;
    expect(String(loans[0].memberId)).toBe(String(winner._id));
  });

  test('race condition at larger scale: five concurrent requests for two copies — exactly two succeed', async () => {
    const members = await Promise.all([1, 2, 3, 4, 5].map(() => createMember()));
    const book = await createBook({ copiesAvailable: 2, totalCopies: 2 });

    const results = await Promise.all(
      members.map((member) => {
        const req = { user: member, body: { bookId: String(book._id) } };
        const res = makeRes();
        return loanController
          .createLoan(req, res, (err) => {
            throw err || new Error('unexpected next() call');
          })
          .then(() => res.statusCode);
      })
    );

    const successCount = results.filter((status) => status === 201).length;
    const rejectedCount = results.filter((status) => status === 409).length;

    expect(successCount).toBe(2);
    expect(rejectedCount).toBe(3);

    const finalBook = await Book.findById(book._id);
    expect(finalBook.copiesAvailable).toBe(0);

    const loans = await Loan.find({ bookId: book._id });
    expect(loans).toHaveLength(2);
  });
});

describe('PATCH /api/loans/:id (updateLoan) — status is never settable here', () => {
  test("a member PATCHing status:'approved' on their own requested loan via the general update route has no effect", async () => {
    const member = await createMember();
    const book = await createBook();
    const loan = await Loan.create({ bookId: book._id, memberId: member._id, status: 'requested' });

    const req = { resource: loan, body: { status: 'approved', memberNote: 'please hurry' } };
    const res = makeRes();

    await loanController.updateLoan(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.loan.memberNote).toBe('please hurry'); // the allowed field DID update
    expect(res.body.loan.status).toBe('requested'); // status silently ignored, not rejected

    const reloaded = await Loan.findById(loan._id);
    expect(reloaded.status).toBe('requested');
    expect(reloaded.decidedBy).toBeUndefined();
  });
});

describe('Librarian admin loan state machine', () => {
  test('approve: requested -> approved, sets decidedBy/decidedAt and a dueDate 14 days from approval', async () => {
    const librarian = await createLibrarian();
    const member = await createMember();
    const book = await createBook();
    const loan = await Loan.create({ bookId: book._id, memberId: member._id, status: 'requested' });

    const before = Date.now();
    const req = { user: librarian, params: { id: String(loan._id) } };
    const res = makeRes();
    await loanController.approve(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.loan.status).toBe('approved');
    expect(String(res.body.loan.decidedBy)).toBe(String(librarian._id));

    const expectedDueDate = before + env.LOAN_PERIOD_DAYS * 24 * 60 * 60 * 1000;
    const actualDueDate = new Date(res.body.loan.dueDate).getTime();
    expect(Math.abs(actualDueDate - expectedDueDate)).toBeLessThan(5000); // within 5s tolerance
  });

  test('approve is rejected on a loan that is not "requested"', async () => {
    const librarian = await createLibrarian();
    const member = await createMember();
    const book = await createBook();
    const loan = await Loan.create({ bookId: book._id, memberId: member._id, status: 'approved' });

    const req = { user: librarian, params: { id: String(loan._id) } };
    const res = makeRes();
    await loanController.approve(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(409);
  });

  test('reject: requested -> rejected, and releases the claimed copy back through the waitlist', async () => {
    const librarian = await createLibrarian();
    const requester = await createMember();
    const waiter = await createMember();
    const book = await createBook({ copiesAvailable: 0, totalCopies: 1 });
    const loan = await Loan.create({ bookId: book._id, memberId: requester._id, status: 'requested' });
    await Waitlist.create({ bookId: book._id, memberId: waiter._id, queuePosition: 1, status: 'waiting' });

    const req = { user: librarian, params: { id: String(loan._id) } };
    const res = makeRes();
    await loanController.reject(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.loan.status).toBe('rejected');

    const reloadedWaiter = await Waitlist.findOne({ memberId: waiter._id });
    expect(reloadedWaiter.status).toBe('offered');
  });

  test('mark-checked-out: approved -> checked_out, sets checkedOutAt', async () => {
    const librarian = await createLibrarian();
    const member = await createMember();
    const book = await createBook();
    const loan = await Loan.create({
      bookId: book._id,
      memberId: member._id,
      status: 'approved',
      dueDate: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });

    const req = { user: librarian, params: { id: String(loan._id) } };
    const res = makeRes();
    await loanController.markCheckedOut(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.loan.status).toBe('checked_out');
    expect(res.body.loan.checkedOutAt).toBeTruthy();
  });

  test('mark-checked-out is rejected directly from "requested" (must go through approve first)', async () => {
    const librarian = await createLibrarian();
    const member = await createMember();
    const book = await createBook();
    const loan = await Loan.create({ bookId: book._id, memberId: member._id, status: 'requested' });

    const req = { user: librarian, params: { id: String(loan._id) } };
    const res = makeRes();
    await loanController.markCheckedOut(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(409);
  });

  test('mark-returned is rejected on a loan that was never checked out', async () => {
    const librarian = await createLibrarian();
    const member = await createMember();
    const book = await createBook();
    const loan = await Loan.create({ bookId: book._id, memberId: member._id, status: 'approved' });

    const req = { user: librarian, params: { id: String(loan._id) } };
    const res = makeRes();
    await loanController.markReturned(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(409);
  });

  test('mark-returned: checked_out -> returned, releases the copy through the waitlist, accepts conditionOnReturn', async () => {
    const librarian = await createLibrarian();
    const requester = await createMember();
    const waiter = await createMember();
    const book = await createBook({ copiesAvailable: 0, totalCopies: 1 });
    const loan = await Loan.create({
      bookId: book._id,
      memberId: requester._id,
      status: 'checked_out',
      checkedOutAt: new Date(),
    });
    await Waitlist.create({ bookId: book._id, memberId: waiter._id, queuePosition: 1, status: 'waiting' });

    const req = {
      user: librarian,
      params: { id: String(loan._id) },
      body: { conditionOnReturn: '<script>alert(1)</script>Good condition' },
    };
    const res = makeRes();
    await loanController.markReturned(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.loan.status).toBe('returned');
    expect(res.body.loan.returnedAt).toBeTruthy();
    expect(res.body.loan.conditionOnReturn).not.toContain('<script');
    expect(res.body.loan.conditionOnReturn).toContain('Good condition');

    const reloadedWaiter = await Waitlist.findOne({ memberId: waiter._id });
    expect(reloadedWaiter.status).toBe('offered');

    // copiesAvailable stays 0 — the freed copy went straight to the
    // waiter's offer, not the general pool (see waitlistService's doc
    // comment on why this must not also be incremented here).
    const reloadedBook = await Book.findById(book._id);
    expect(reloadedBook.copiesAvailable).toBe(0);
  });

  test('mark-returned also works from "overdue" (a late book still eventually comes back)', async () => {
    const librarian = await createLibrarian();
    const member = await createMember();
    const book = await createBook({ copiesAvailable: 0, totalCopies: 1 });
    const loan = await Loan.create({
      bookId: book._id,
      memberId: member._id,
      status: 'overdue',
      checkedOutAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      dueDate: new Date(Date.now() - 16 * 24 * 60 * 60 * 1000),
    });

    const req = { user: librarian, params: { id: String(loan._id) } };
    const res = makeRes();
    await loanController.markReturned(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.loan.status).toBe('returned');

    const reloadedBook = await Book.findById(book._id);
    expect(reloadedBook.copiesAvailable).toBe(1); // nobody waiting, copy returns to the pool
  });

  test('mark-damaged: checked_out -> damaged, also releases the copy (the book physically came back)', async () => {
    const librarian = await createLibrarian();
    const member = await createMember();
    const book = await createBook({ copiesAvailable: 0, totalCopies: 1 });
    const loan = await Loan.create({ bookId: book._id, memberId: member._id, status: 'checked_out' });

    const req = { user: librarian, params: { id: String(loan._id) }, body: { conditionOnReturn: 'Water damaged' } };
    const res = makeRes();
    await loanController.markDamaged(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.loan.status).toBe('damaged');
    expect(res.body.loan.returnedAt).toBeTruthy();

    const reloadedBook = await Book.findById(book._id);
    expect(reloadedBook.copiesAvailable).toBe(1); // released — the book did come back
  });

  test('mark-lost: checked_out -> lost, does NOT release the copy (the book is gone)', async () => {
    const librarian = await createLibrarian();
    const member = await createMember();
    const book = await createBook({ copiesAvailable: 0, totalCopies: 1 });
    const loan = await Loan.create({ bookId: book._id, memberId: member._id, status: 'checked_out' });

    const req = { user: librarian, params: { id: String(loan._id) } };
    const res = makeRes();
    await loanController.markLost(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.loan.status).toBe('lost');

    const reloadedBook = await Book.findById(book._id);
    expect(reloadedBook.copiesAvailable).toBe(0); // NOT released — the copy isn't coming back
  });

  test('mark-lost also works directly from "overdue"', async () => {
    const librarian = await createLibrarian();
    const member = await createMember();
    const book = await createBook();
    const loan = await Loan.create({ bookId: book._id, memberId: member._id, status: 'overdue' });

    const req = { user: librarian, params: { id: String(loan._id) } };
    const res = makeRes();
    await loanController.markLost(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.loan.status).toBe('lost');
  });

  test('404s for a nonexistent loan id', async () => {
    const librarian = await createLibrarian();
    const req = { user: librarian, params: { id: new mongoose.Types.ObjectId().toString() } };
    const res = makeRes();
    await loanController.approve(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(404);
  });

  test('race condition: two concurrent approve requests for the same loan — only one succeeds', async () => {
    const librarianA = await createLibrarian();
    const librarianB = await createLibrarian();
    const member = await createMember();
    const book = await createBook();
    const loan = await Loan.create({ bookId: book._id, memberId: member._id, status: 'requested' });

    const req1 = { user: librarianA, params: { id: String(loan._id) } };
    const req2 = { user: librarianB, params: { id: String(loan._id) } };
    const res1 = makeRes();
    const res2 = makeRes();

    await Promise.all([
      loanController.approve(req1, res1, (e) => { throw e || new Error('unexpected next (1)'); }),
      loanController.approve(req2, res2, (e) => { throw e || new Error('unexpected next (2)'); }),
    ]);

    const statuses = [res1.statusCode, res2.statusCode].sort();
    expect(statuses).toEqual([200, 409]);

    const reloaded = await Loan.findById(loan._id);
    expect(reloaded.status).toBe('approved');
  });
});

describe('loanService.sweepOverdueLoans', () => {
  test('flips a checked-out loan past its dueDate to overdue and writes an audit log entry', async () => {
    const member = await createMember();
    const book = await createBook();
    const loan = await Loan.create({
      bookId: book._id,
      memberId: member._id,
      status: 'checked_out',
      checkedOutAt: new Date(Date.now() - 20 * 24 * 60 * 60 * 1000),
      dueDate: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000), // 6 days past due
    });

    await loanService.sweepOverdueLoans();

    const reloaded = await Loan.findById(loan._id);
    expect(reloaded.status).toBe('overdue');

    const logs = await AuditLog.find({ resourceId: loan._id, action: 'loan_overdue' });
    expect(logs).toHaveLength(1);
  });

  test('leaves checked-out loans not yet past their dueDate untouched', async () => {
    const member = await createMember();
    const book = await createBook();
    const loan = await Loan.create({
      bookId: book._id,
      memberId: member._id,
      status: 'checked_out',
      checkedOutAt: new Date(),
      dueDate: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // not due yet
    });

    await loanService.sweepOverdueLoans();

    const reloaded = await Loan.findById(loan._id);
    expect(reloaded.status).toBe('checked_out');
  });

  test('never touches loans in other statuses even if their dueDate has passed', async () => {
    const member = await createMember();
    const book = await createBook();
    const loan = await Loan.create({
      bookId: book._id,
      memberId: member._id,
      status: 'returned',
      dueDate: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
      returnedAt: new Date(),
    });

    await loanService.sweepOverdueLoans();

    const reloaded = await Loan.findById(loan._id);
    expect(reloaded.status).toBe('returned');
  });
});

describe('DELETE /api/loans/:id (cancelLoan) — soft-cancel, not a hard delete', () => {
  test('cancelling a requested loan sets status to cancelled and keeps the document', async () => {
    const member = await createMember();
    const book = await createBook({ copiesAvailable: 0, totalCopies: 1 });
    const loan = await Loan.create({ bookId: book._id, memberId: member._id, status: 'requested' });

    const req = { resource: loan, user: member };
    const res = makeRes();
    await loanController.cancelLoan(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);

    const reloaded = await Loan.findById(loan._id);
    expect(reloaded).not.toBeNull(); // still exists — soft cancel, not a delete
    expect(reloaded.status).toBe('cancelled');
    expect(String(reloaded.decidedBy)).toBe(String(member._id));
  });

  test('rejects cancelling a loan that is not "requested"', async () => {
    const member = await createMember();
    const book = await createBook();
    const loan = await Loan.create({ bookId: book._id, memberId: member._id, status: 'checked_out' });

    const req = { resource: loan, user: member };
    const res = makeRes();
    await loanController.cancelLoan(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(400);
  });
});
