const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../src/models/User');
const Book = require('../src/models/Book');
const Loan = require('../src/models/Loan');
const Waitlist = require('../src/models/Waitlist');
const waitlistController = require('../src/controllers/waitlist.controller');
const loanController = require('../src/controllers/loan.controller');
const waitlistService = require('../src/services/waitlistService');

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
  res.send = (body) => {
    if (body !== undefined) res.body = body;
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

async function createBook(overrides = {}) {
  return Book.create({
    title: 'Test Book',
    author: 'Test Author',
    isbn: '000-0-00-000000-0',
    totalCopies: 1,
    copiesAvailable: 0,
    ...overrides,
  });
}

describe('POST /api/waitlist (joinWaitlist)', () => {
  test('rejects joining when copies are currently available', async () => {
    const member = await createMember();
    const book = await createBook({ copiesAvailable: 2 });

    const req = { user: member, body: { bookId: String(book._id) } };
    const res = makeRes();
    await waitlistController.joinWaitlist(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(400);
  });

  test('404s for a nonexistent or retired book', async () => {
    const member = await createMember();
    const retiredBook = await createBook({ status: 'retired' });

    const res1 = makeRes();
    await waitlistController.joinWaitlist(
      { user: member, body: { bookId: new mongoose.Types.ObjectId().toString() } },
      res1,
      (err) => { throw err || new Error('unexpected next()'); }
    );
    expect(res1.statusCode).toBe(404);

    const res2 = makeRes();
    await waitlistController.joinWaitlist(
      { user: member, body: { bookId: String(retiredBook._id) } },
      res2,
      (err) => { throw err || new Error('unexpected next()'); }
    );
    expect(res2.statusCode).toBe(404);
  });

  test('assigns strictly increasing sequential queue positions', async () => {
    const book = await createBook();
    const memberA = await createMember();
    const memberB = await createMember();
    const memberC = await createMember();

    const resA = makeRes();
    await waitlistController.joinWaitlist({ user: memberA, body: { bookId: String(book._id) } }, resA, (e) => { throw e; });
    const resB = makeRes();
    await waitlistController.joinWaitlist({ user: memberB, body: { bookId: String(book._id) } }, resB, (e) => { throw e; });
    const resC = makeRes();
    await waitlistController.joinWaitlist({ user: memberC, body: { bookId: String(book._id) } }, resC, (e) => { throw e; });

    expect(resA.body.waitlistEntry.queuePosition).toBeLessThan(resB.body.waitlistEntry.queuePosition);
    expect(resB.body.waitlistEntry.queuePosition).toBeLessThan(resC.body.waitlistEntry.queuePosition);
  });

  test('rejects a duplicate join while the member already has a waiting entry', async () => {
    const book = await createBook();
    const member = await createMember();

    const res1 = makeRes();
    await waitlistController.joinWaitlist({ user: member, body: { bookId: String(book._id) } }, res1, (e) => { throw e; });
    expect(res1.statusCode).toBe(201);

    const res2 = makeRes();
    await waitlistController.joinWaitlist({ user: member, body: { bookId: String(book._id) } }, res2, (e) => { throw e; });
    expect(res2.statusCode).toBe(409);

    const entries = await Waitlist.find({ bookId: book._id, memberId: member._id });
    expect(entries).toHaveLength(1);
  });

  test('concurrent joins from different members each get a distinct queue position', async () => {
    const book = await createBook();
    const members = await Promise.all([1, 2, 3, 4, 5].map(() => createMember()));

    const results = await Promise.all(
      members.map((member) => {
        const req = { user: member, body: { bookId: String(book._id) } };
        const res = makeRes();
        return waitlistController
          .joinWaitlist(req, res, (e) => { throw e; })
          .then(() => res.body.waitlistEntry.queuePosition);
      })
    );

    const uniquePositions = new Set(results);
    expect(uniquePositions.size).toBe(5); // no two members collided on the same position
  });
});

describe('waitlistService.offerNextInQueue', () => {
  test('offers the earliest waiting entry and does NOT touch copiesAvailable', async () => {
    const book = await createBook({ copiesAvailable: 0 });
    const memberA = await createMember();
    const memberB = await createMember();

    await Waitlist.create({ bookId: book._id, memberId: memberA._id, queuePosition: 1, status: 'waiting' });
    await Waitlist.create({ bookId: book._id, memberId: memberB._id, queuePosition: 2, status: 'waiting' });

    const { offered } = await waitlistService.offerNextInQueue(book._id);

    expect(String(offered.memberId)).toBe(String(memberA._id)); // earliest position wins
    expect(offered.status).toBe('offered');
    expect(offered.offerExpiresAt).toBeInstanceOf(Date);

    const reloadedBook = await Book.findById(book._id);
    expect(reloadedBook.copiesAvailable).toBe(0); // copy stays reserved, not put back in the pool

    const stillWaiting = await Waitlist.findOne({ memberId: memberB._id });
    expect(stillWaiting.status).toBe('waiting'); // second-in-line untouched
  });

  test('increments copiesAvailable when nobody is waiting', async () => {
    const book = await createBook({ copiesAvailable: 0 });

    const { offered } = await waitlistService.offerNextInQueue(book._id);

    expect(offered).toBeNull();
    const reloadedBook = await Book.findById(book._id);
    expect(reloadedBook.copiesAvailable).toBe(1);
  });
});

describe('POST /api/waitlist/:id/claim', () => {
  test('a valid claim creates a loan and marks the entry fulfilled', async () => {
    const book = await createBook({ copiesAvailable: 0 });
    const member = await createMember();
    const entry = await Waitlist.create({
      bookId: book._id,
      memberId: member._id,
      queuePosition: 1,
      status: 'offered',
      offeredAt: new Date(),
      offerExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const req = { user: member, params: { id: String(entry._id) } };
    const res = makeRes();
    await waitlistController.claimWaitlistOffer(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(201);
    expect(res.body.loan.status).toBe('requested');

    const reloadedEntry = await Waitlist.findById(entry._id);
    expect(reloadedEntry.status).toBe('fulfilled');

    // Deliberately unchanged — the copy was never added back to the pool
    // in the first place (see offerNextInQueue's doc comment), so
    // claiming it doesn't decrement anything either.
    const reloadedBook = await Book.findById(book._id);
    expect(reloadedBook.copiesAvailable).toBe(0);
  });

  test('rejects a claim after the offer has expired', async () => {
    const book = await createBook();
    const member = await createMember();
    const entry = await Waitlist.create({
      bookId: book._id,
      memberId: member._id,
      queuePosition: 1,
      status: 'offered',
      offeredAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      offerExpiresAt: new Date(Date.now() - 60 * 60 * 1000), // already expired
    });

    const req = { user: member, params: { id: String(entry._id) } };
    const res = makeRes();
    await waitlistController.claimWaitlistOffer(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(404);
  });

  test('rejects a claim attempt by someone other than the offered member', async () => {
    const book = await createBook();
    const owner = await createMember();
    const attacker = await createMember();
    const entry = await Waitlist.create({
      bookId: book._id,
      memberId: owner._id,
      queuePosition: 1,
      status: 'offered',
      offeredAt: new Date(),
      offerExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const req = { user: attacker, params: { id: String(entry._id) } };
    const res = makeRes();
    await waitlistController.claimWaitlistOffer(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(404);
    const reloadedEntry = await Waitlist.findById(entry._id);
    expect(reloadedEntry.status).toBe('offered'); // untouched
  });

  test('race condition: two concurrent claim requests for the same offer — only one succeeds', async () => {
    const book = await createBook();
    const member = await createMember();
    const entry = await Waitlist.create({
      bookId: book._id,
      memberId: member._id,
      queuePosition: 1,
      status: 'offered',
      offeredAt: new Date(),
      offerExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const req1 = { user: member, params: { id: String(entry._id) } };
    const req2 = { user: member, params: { id: String(entry._id) } };
    const res1 = makeRes();
    const res2 = makeRes();

    await Promise.all([
      waitlistController.claimWaitlistOffer(req1, res1, (e) => { throw e || new Error('unexpected next (1)'); }),
      waitlistController.claimWaitlistOffer(req2, res2, (e) => { throw e || new Error('unexpected next (2)'); }),
    ]);

    const statuses = [res1.statusCode, res2.statusCode].sort();
    expect(statuses).toEqual([201, 404]);

    const loans = await Loan.find({ bookId: book._id, memberId: member._id });
    expect(loans).toHaveLength(1); // only one loan ever created
  });
});

describe('DELETE /api/waitlist/:id (leaveWaitlist)', () => {
  test('cancels a waiting entry', async () => {
    const book = await createBook();
    const member = await createMember();
    const entry = await Waitlist.create({ bookId: book._id, memberId: member._id, queuePosition: 1, status: 'waiting' });

    const req = { resource: entry };
    const res = makeRes();
    await waitlistController.leaveWaitlist(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    const reloaded = await Waitlist.findById(entry._id);
    expect(reloaded.status).toBe('cancelled');
  });

  test('cancelling an offered entry passes the offer to the next person in line', async () => {
    const book = await createBook({ copiesAvailable: 0 });
    const memberA = await createMember();
    const memberB = await createMember();

    const entryA = await Waitlist.create({
      bookId: book._id,
      memberId: memberA._id,
      queuePosition: 1,
      status: 'offered',
      offeredAt: new Date(),
      offerExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });
    await Waitlist.create({ bookId: book._id, memberId: memberB._id, queuePosition: 2, status: 'waiting' });

    const req = { resource: entryA };
    const res = makeRes();
    await waitlistController.leaveWaitlist(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);

    const reloadedA = await Waitlist.findById(entryA._id);
    expect(reloadedA.status).toBe('cancelled');

    const reloadedB = await Waitlist.findOne({ memberId: memberB._id });
    expect(reloadedB.status).toBe('offered'); // next in line now has the offer
  });

  test('rejects leaving an already-terminal entry', async () => {
    const book = await createBook();
    const member = await createMember();
    const entry = await Waitlist.create({ bookId: book._id, memberId: member._id, queuePosition: 1, status: 'expired' });

    const req = { resource: entry };
    const res = makeRes();
    await waitlistController.leaveWaitlist(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(400);
  });
});

describe('waitlistService.sweepExpiredOffers', () => {
  test('expires past-window offers and hands them to the next person in line', async () => {
    const book = await createBook({ copiesAvailable: 0 });
    const memberA = await createMember();
    const memberB = await createMember();

    await Waitlist.create({
      bookId: book._id,
      memberId: memberA._id,
      queuePosition: 1,
      status: 'offered',
      offeredAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      offerExpiresAt: new Date(Date.now() - 60 * 60 * 1000), // already past
    });
    await Waitlist.create({ bookId: book._id, memberId: memberB._id, queuePosition: 2, status: 'waiting' });

    await waitlistService.sweepExpiredOffers();

    const reloadedA = await Waitlist.findOne({ memberId: memberA._id });
    expect(reloadedA.status).toBe('expired');

    const reloadedB = await Waitlist.findOne({ memberId: memberB._id });
    expect(reloadedB.status).toBe('offered');
  });

  test('leaves offers still within their claim window untouched', async () => {
    const book = await createBook();
    const member = await createMember();

    await Waitlist.create({
      bookId: book._id,
      memberId: member._id,
      queuePosition: 1,
      status: 'offered',
      offeredAt: new Date(),
      offerExpiresAt: new Date(Date.now() + 60 * 60 * 1000), // still valid
    });

    await waitlistService.sweepExpiredOffers();

    const reloaded = await Waitlist.findOne({ memberId: member._id });
    expect(reloaded.status).toBe('offered');
  });

  test('when nobody is left in line, the swept copy returns to the general pool', async () => {
    const book = await createBook({ copiesAvailable: 0 });
    const member = await createMember();

    await Waitlist.create({
      bookId: book._id,
      memberId: member._id,
      queuePosition: 1,
      status: 'offered',
      offeredAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      offerExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await waitlistService.sweepExpiredOffers();

    const reloadedBook = await Book.findById(book._id);
    expect(reloadedBook.copiesAvailable).toBe(1);
  });
});

describe('GET /api/waitlist/me', () => {
  test("returns only the requesting member's own entries, with basic book info populated", async () => {
    const memberA = await createMember();
    const memberB = await createMember();
    const book = await createBook();

    await Waitlist.create({ bookId: book._id, memberId: memberA._id, queuePosition: 1, status: 'waiting' });
    await Waitlist.create({ bookId: book._id, memberId: memberB._id, queuePosition: 2, status: 'waiting' });

    const req = { user: memberA };
    const res = makeRes();
    await waitlistController.getMyWaitlist(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.waitlist).toHaveLength(1);
    expect(res.body.waitlist[0].bookId.title).toBe('Test Book');
  });
});

describe('integration: cancelling a requested loan releases the copy through the waitlist', () => {
  test('DELETE /api/loans/:id on a requested loan offers the freed copy to the waiting member', async () => {
    const book = await createBook({ copiesAvailable: 0, totalCopies: 1 });
    const requester = await createMember();
    const waiter = await createMember();

    // requester currently holds the only copy via a 'requested' loan
    // (as Phase 18's createLoan would have atomically claimed it)
    const loan = await Loan.create({ bookId: book._id, memberId: requester._id, status: 'requested' });
    await Waitlist.create({ bookId: book._id, memberId: waiter._id, queuePosition: 1, status: 'waiting' });

    const req = { resource: loan, user: requester };
    const res = makeRes();
    await loanController.cancelLoan(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);

    const reloadedWaiter = await Waitlist.findOne({ memberId: waiter._id });
    expect(reloadedWaiter.status).toBe('offered');

    // still 0 — the freed copy went straight to the waiter's offer, not
    // back into the general pool
    const reloadedBook = await Book.findById(book._id);
    expect(reloadedBook.copiesAvailable).toBe(0);
  });

  test('cancelling a non-"requested" loan is rejected rather than releasing a copy', async () => {
    const book = await createBook({ copiesAvailable: 0, totalCopies: 1 });
    const member = await createMember();
    const loan = await Loan.create({ bookId: book._id, memberId: member._id, status: 'checked_out' });

    const req = { resource: loan };
    const res = makeRes();
    await loanController.cancelLoan(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(400);
    const stillExists = await Loan.findById(loan._id);
    expect(stillExists).not.toBeNull();
  });
});
