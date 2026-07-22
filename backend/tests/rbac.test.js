const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../src/models/User');
const Book = require('../src/models/Book');
const Loan = require('../src/models/Loan');
const { requireOwnership } = require('../src/middleware/ownership');

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

async function createLoanFor(memberId) {
  const book = await Book.create({
    title: 'Test Book',
    author: 'Test Author',
    isbn: '000-0-00-000000-0',
    totalCopies: 1,
    copiesAvailable: 1,
  });
  return Loan.create({ bookId: book._id, memberId, status: 'requested' });
}

describe('requireOwnership (IDOR prevention)', () => {
  const requireLoanOwnership = requireOwnership(Loan, 'id', 'memberId');

  test("member A gets 404 on member B's loan", async () => {
    const memberA = await User.create({
      name: 'Member A',
      email: 'a@example.com',
      passwordHash: 'irrelevant-for-this-test',
      role: 'member',
    });
    const memberB = await User.create({
      name: 'Member B',
      email: 'b@example.com',
      passwordHash: 'irrelevant-for-this-test',
      role: 'member',
    });
    const loan = await createLoanFor(memberB._id);

    const req = { params: { id: String(loan._id) }, user: memberA };
    const res = makeRes();
    let nextCalled = false;

    await requireLoanOwnership(req, res, () => {
      nextCalled = true;
    });

    expect(res.statusCode).toBe(404);
    expect(nextCalled).toBe(false);
    expect(req.resource).toBeUndefined();
  });

  test('the owning member can access their own loan', async () => {
    const memberB = await User.create({
      name: 'Member B',
      email: 'b2@example.com',
      passwordHash: 'irrelevant-for-this-test',
      role: 'member',
    });
    const loan = await createLoanFor(memberB._id);

    const req = { params: { id: String(loan._id) }, user: memberB };
    const res = makeRes();
    let nextCalled = false;

    await requireLoanOwnership(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeUndefined();
    expect(String(req.resource._id)).toBe(String(loan._id));
  });

  test('a librarian can access any loan regardless of ownership', async () => {
    const memberB = await User.create({
      name: 'Member B',
      email: 'b3@example.com',
      passwordHash: 'irrelevant-for-this-test',
      role: 'member',
    });
    const librarian = await User.create({
      name: 'Librarian',
      email: 'lib@example.com',
      passwordHash: 'irrelevant-for-this-test',
      role: 'librarian',
    });
    const loan = await createLoanFor(memberB._id);

    const req = { params: { id: String(loan._id) }, user: librarian };
    const res = makeRes();
    let nextCalled = false;

    await requireLoanOwnership(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(String(req.resource._id)).toBe(String(loan._id));
  });

  test('a nonexistent loan id returns 404', async () => {
    const memberA = await User.create({
      name: 'Member A',
      email: 'a4@example.com',
      passwordHash: 'irrelevant-for-this-test',
      role: 'member',
    });

    const req = { params: { id: new mongoose.Types.ObjectId().toString() }, user: memberA };
    const res = makeRes();
    let nextCalled = false;

    await requireLoanOwnership(req, res, () => {
      nextCalled = true;
    });

    expect(res.statusCode).toBe(404);
    expect(nextCalled).toBe(false);
  });

  test('a malformed id returns 404, not a 500', async () => {
    const memberA = await User.create({
      name: 'Member A',
      email: 'a5@example.com',
      passwordHash: 'irrelevant-for-this-test',
      role: 'member',
    });

    const req = { params: { id: 'not-a-valid-object-id' }, user: memberA };
    const res = makeRes();
    let nextCalled = false;
    let errorPassedToNext;

    await requireLoanOwnership(req, res, (err) => {
      nextCalled = true;
      errorPassedToNext = err;
    });

    expect(res.statusCode).toBe(404);
    expect(nextCalled).toBe(false);
    expect(errorPassedToNext).toBeUndefined();
  });
});
