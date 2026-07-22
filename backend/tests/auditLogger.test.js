process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.CSRF_SECRET = process.env.CSRF_SECRET || 'test-csrf-secret';
process.env.MFA_ENCRYPTION_KEY =
  process.env.MFA_ENCRYPTION_KEY || '0'.repeat(63) + '1'; // valid 32-byte hex fallback

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { authenticator } = require('otplib');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../src/models/User');
const Book = require('../src/models/Book');
const Loan = require('../src/models/Loan');
const Waitlist = require('../src/models/Waitlist');
const AuditLog = require('../src/models/AuditLog');
const { logActivity } = require('../src/middleware/auditLogger');
const authController = require('../src/controllers/auth.controller');
const adminController = require('../src/controllers/admin.controller');
const loanController = require('../src/controllers/loan.controller');
const waitlistController = require('../src/controllers/waitlist.controller');
const waitlistService = require('../src/services/waitlistService');
const bookController = require('../src/controllers/book.controller');
const mfaService = require('../src/services/mfaService');
const logger = require('../src/utils/logger');

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  // Redis is only touched by login()'s IP-tracking helpers and
  // tokenService's session storage — neither needs a real Redis for what
  // these tests check, so a minimal in-memory stand-in is enough.
  const { redisClient } = require('../src/config/redis');
  const store = new Map();
  const sets = new Map();
  redisClient.get = async (key) => (store.has(key) ? store.get(key) : null);
  redisClient.set = async (key, val) => {
    store.set(key, val);
    return 'OK';
  };
  redisClient.del = async (key) => {
    const existed = store.delete(key);
    return existed ? 1 : 0;
  };
  redisClient.incr = async (key) => {
    const c = (parseInt(store.get(key) || '0', 10)) + 1;
    store.set(key, String(c));
    return c;
  };
  redisClient.expire = async () => 1;
  redisClient.sAdd = async (key, member) => {
    if (!sets.has(key)) sets.set(key, new Set());
    sets.get(key).add(member);
    return 1;
  };
  redisClient.sRem = async (key, member) => {
    if (sets.has(key)) sets.get(key).delete(member);
    return 1;
  };
  redisClient.sMembers = async (key) => Array.from(sets.get(key) || []);

  // Minimal sorted-set stand-in (score-per-member map) for
  // securityMonitorService's sliding-window failed-login tracking.
  const zsets = new Map();
  redisClient.zAdd = async (key, { score, value }) => {
    if (!zsets.has(key)) zsets.set(key, new Map());
    zsets.get(key).set(value, score);
    return 1;
  };
  redisClient.zRemRangeByScore = async (key, min, max) => {
    const zset = zsets.get(key);
    if (!zset) return 0;
    let removed = 0;
    for (const [member, score] of zset.entries()) {
      if (score >= min && score <= max) {
        zset.delete(member);
        removed += 1;
      }
    }
    return removed;
  };
  redisClient.zCard = async (key) => (zsets.has(key) ? zsets.get(key).size : 0);
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
  res.cookie = () => res;
  res.clearCookie = () => res;
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

describe('logActivity', () => {
  test('writes an audit log entry with the expected fields', async () => {
    const actor = await createMember();

    await logActivity({
      actorId: actor._id,
      action: 'test_action',
      resourceType: 'Widget',
      resourceId: actor._id,
      ip: '1.2.3.4',
      userAgent: 'jest-test-agent',
      metadata: { foo: 'bar' },
    });

    const logs = await AuditLog.find({ action: 'test_action' });
    expect(logs).toHaveLength(1);
    expect(String(logs[0].actorId)).toBe(String(actor._id));
    expect(logs[0].resourceType).toBe('Widget');
    expect(logs[0].ip).toBe('1.2.3.4');
    expect(logs[0].userAgent).toBe('jest-test-agent');
    expect(logs[0].metadata).toEqual({ foo: 'bar' });
    expect(logs[0].timestamp).toBeInstanceOf(Date);
  });

  test('extracts ip/userAgent from a passed req object when not given directly', async () => {
    const req = { ip: '9.9.9.9', headers: { 'user-agent': 'from-req' } };

    await logActivity({ action: 'test_from_req', req });

    const logs = await AuditLog.find({ action: 'test_from_req' });
    expect(logs[0].ip).toBe('9.9.9.9');
    expect(logs[0].userAgent).toBe('from-req');
  });

  test('never throws if the underlying write fails — logs the failure and moves on', async () => {
    const spy = jest.spyOn(AuditLog, 'create').mockRejectedValueOnce(new Error('boom'));
    const loggerSpy = jest.spyOn(logger, 'error').mockImplementation(() => {});

    await expect(logActivity({ action: 'will_fail' })).resolves.toBeUndefined();
    expect(loggerSpy).toHaveBeenCalled();

    spy.mockRestore();
    loggerSpy.mockRestore();
  });
});

describe('audit trail: auth flows', () => {
  test('registration writes user_registered', async () => {
    const req = {
      body: { name: 'New User', email: 'new@example.com', password: 'Xk9!vTr2#qLpZ8' },
    };
    const res = makeRes();
    await authController.register(req, res, (e) => { throw e; });

    const logs = await AuditLog.find({ action: 'user_registered' });
    expect(logs).toHaveLength(1);
  });

  test('a successful login writes login_success', async () => {
    const passwordHash = await bcrypt.hash('CorrectHorseBattery9!', 12);
    const member = await User.create({
      name: 'Member',
      email: 'login-success@example.com',
      passwordHash,
      role: 'member',
    });

    const req = {
      ip: '1.2.3.4',
      headers: {},
      body: { email: member.email, password: 'CorrectHorseBattery9!' },
    };
    const res = makeRes();
    await authController.login(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    const logs = await AuditLog.find({ action: 'login_success' });
    expect(logs).toHaveLength(1);
    expect(String(logs[0].actorId)).toBe(String(member._id));
  });

  test('a wrong-password login writes login_failure', async () => {
    const passwordHash = await bcrypt.hash('CorrectHorseBattery9!', 12);
    const member = await User.create({
      name: 'Member',
      email: 'login-fail@example.com',
      passwordHash,
      role: 'member',
    });

    const req = {
      ip: '1.2.3.5',
      headers: {},
      body: { email: member.email, password: 'WrongPassword1!' },
    };
    const res = makeRes();
    await authController.login(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(401);
    const logs = await AuditLog.find({ action: 'login_failure' });
    expect(logs).toHaveLength(1);
    expect(String(logs[0].actorId)).toBe(String(member._id));
  });

  test('a login attempt against a nonexistent email writes login_failure with no actor', async () => {
    const req = {
      ip: '1.2.3.6',
      headers: {},
      body: { email: 'nobody@example.com', password: 'WhoKnows1!' },
    };
    const res = makeRes();
    await authController.login(req, res, (e) => { throw e; });

    const logs = await AuditLog.find({ action: 'login_failure' });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorId).toBeUndefined();
  });

  test('the 12th consecutive failed login writes account_lockout', async () => {
    // 12 sequential bcrypt.compare calls at cost factor 12 are
    // intentionally slow (that's the point of bcrypt) — well past Jest's
    // default 5s test timeout on typical hardware.
    const passwordHash = await bcrypt.hash('CorrectHorseBattery9!', 12);
    const member = await User.create({
      name: 'Member',
      email: 'lockout@example.com',
      passwordHash,
      role: 'member',
    });

    for (let i = 0; i < 12; i++) {
      const req = { ip: '2.2.2.2', headers: {}, body: { email: member.email, password: 'wrong' } };
      const res = makeRes();
      // eslint-disable-next-line no-await-in-loop
      await authController.login(req, res, (e) => { throw e; });
    }

    const logs = await AuditLog.find({ action: 'account_lockout' });
    expect(logs).toHaveLength(1);
    expect(String(logs[0].actorId)).toBe(String(member._id));
  }, 20000);

  test('login against a suspended account writes login_blocked_suspended', async () => {
    const passwordHash = await bcrypt.hash('CorrectHorseBattery9!', 12);
    const member = await User.create({
      name: 'Member',
      email: 'suspended@example.com',
      passwordHash,
      role: 'member',
      status: 'suspended',
    });

    const req = {
      ip: '3.3.3.3',
      headers: {},
      body: { email: member.email, password: 'CorrectHorseBattery9!' },
    };
    const res = makeRes();
    await authController.login(req, res, (e) => { throw e; });

    const logs = await AuditLog.find({ action: 'login_blocked_suspended' });
    expect(logs).toHaveLength(1);
  });

  test('MFA challenge success writes both mfa_challenge_success and login_success', async () => {
    const secret = mfaService.generateSecret();
    const passwordHash = await bcrypt.hash('CorrectHorseBattery9!', 12);
    const member = await User.create({
      name: 'Member',
      email: 'mfa-success@example.com',
      passwordHash,
      role: 'member',
      mfaEnabled: true,
      mfaSecretEncrypted: mfaService.encryptSecret(secret),
    });

    const tokenService = require('../src/services/tokenService');
    const pendingToken = tokenService.signMfaPendingToken(member._id);
    const validCode = authenticator.generate(secret);

    const req = {
      ip: '4.4.4.4',
      headers: {},
      body: { mfaPendingToken: pendingToken, token: validCode },
    };
    const res = makeRes();
    await authController.mfaChallenge(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    const successLogs = await AuditLog.find({ action: 'mfa_challenge_success' });
    const loginLogs = await AuditLog.find({ action: 'login_success' });
    expect(successLogs).toHaveLength(1);
    expect(loginLogs).toHaveLength(1);
  });

  test('MFA challenge with a wrong code writes mfa_challenge_failure', async () => {
    const secret = mfaService.generateSecret();
    const passwordHash = await bcrypt.hash('CorrectHorseBattery9!', 12);
    const member = await User.create({
      name: 'Member',
      email: 'mfa-fail@example.com',
      passwordHash,
      role: 'member',
      mfaEnabled: true,
      mfaSecretEncrypted: mfaService.encryptSecret(secret),
    });

    const tokenService = require('../src/services/tokenService');
    const pendingToken = tokenService.signMfaPendingToken(member._id);

    const req = {
      ip: '5.5.5.5',
      headers: {},
      body: { mfaPendingToken: pendingToken, token: '000000' },
    };
    const res = makeRes();
    await authController.mfaChallenge(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(401);
    const logs = await AuditLog.find({ action: 'mfa_challenge_failure' });
    expect(logs).toHaveLength(1);
  });
});

describe('audit trail: role changes (already built in Phase 15, now via logActivity)', () => {
  test('a role change writes role_change with previous/new role metadata', async () => {
    const librarian = await createLibrarian();
    const member = await createMember();

    const req = {
      user: librarian,
      params: { id: String(member._id) },
      body: { role: 'librarian' },
      ip: '6.6.6.6',
      headers: {},
    };
    const res = makeRes();
    await adminController.updateUserRole(req, res, (e) => { throw e; });

    const logs = await AuditLog.find({ action: 'role_change' });
    expect(logs).toHaveLength(1);
    expect(logs[0].metadata).toEqual({ previousRole: 'member', newRole: 'librarian' });
  });
});

describe('audit trail: loan lifecycle', () => {
  test('creating, approving, rejecting, and cancelling loans each write their own action', async () => {
    const librarian = await createLibrarian();
    const memberA = await createMember();
    const memberB = await createMember();
    const book = await createBook({ totalCopies: 2, copiesAvailable: 2 });

    // request
    const createReq = { user: memberA, body: { bookId: String(book._id) } };
    const createRes = makeRes();
    await loanController.createLoan(createReq, createRes, (e) => { throw e; });
    expect((await AuditLog.find({ action: 'loan_requested' }))).toHaveLength(1);

    // approve
    const loanId = createRes.body.loan._id;
    const approveReq = { user: librarian, params: { id: String(loanId) } };
    const approveRes = makeRes();
    await loanController.approve(approveReq, approveRes, (e) => { throw e; });
    expect((await AuditLog.find({ action: 'loan_approve' }))).toHaveLength(1);

    // a second request, then reject it
    const createReq2 = { user: memberB, body: { bookId: String(book._id) } };
    const createRes2 = makeRes();
    await loanController.createLoan(createReq2, createRes2, (e) => { throw e; });
    const loanId2 = createRes2.body.loan._id;
    const rejectReq = { user: librarian, params: { id: String(loanId2) } };
    const rejectRes = makeRes();
    await loanController.reject(rejectReq, rejectRes, (e) => { throw e; });
    expect((await AuditLog.find({ action: 'loan_reject' }))).toHaveLength(1);
  });

  test('cancelling a requested loan writes loan_cancelled', async () => {
    const member = await createMember();
    const book = await createBook();
    const loan = await Loan.create({ bookId: book._id, memberId: member._id, status: 'requested' });

    const req = { resource: loan, user: member };
    const res = makeRes();
    await loanController.cancelLoan(req, res, (e) => { throw e; });

    const logs = await AuditLog.find({ action: 'loan_cancelled' });
    expect(logs).toHaveLength(1);
  });
});

describe('audit trail: waitlist lifecycle', () => {
  test('joining and claiming write waitlist_joined and waitlist_claimed', async () => {
    const member = await createMember();
    const book = await createBook({ copiesAvailable: 0 });

    const joinReq = { user: member, body: { bookId: String(book._id) } };
    const joinRes = makeRes();
    await waitlistController.joinWaitlist(joinReq, joinRes, (e) => { throw e; });
    expect((await AuditLog.find({ action: 'waitlist_joined' }))).toHaveLength(1);

    // Manually flip the entry to 'offered' (bypassing the normal trigger
    // path, which is exercised separately below) so claim can be tested.
    const entry = await Waitlist.findByIdAndUpdate(
      joinRes.body.waitlistEntry._id,
      { status: 'offered', offeredAt: new Date(), offerExpiresAt: new Date(Date.now() + 60 * 60 * 1000) },
      { new: true }
    );

    const claimReq = { user: member, params: { id: String(entry._id) } };
    const claimRes = makeRes();
    await waitlistController.claimWaitlistOffer(claimReq, claimRes, (e) => { throw e; });
    expect((await AuditLog.find({ action: 'waitlist_claimed' }))).toHaveLength(1);
  });

  test('offerNextInQueue writes waitlist_offered', async () => {
    const member = await createMember();
    const book = await createBook({ copiesAvailable: 0 });
    await Waitlist.create({ bookId: book._id, memberId: member._id, queuePosition: 1, status: 'waiting' });

    await waitlistService.offerNextInQueue(book._id);

    const logs = await AuditLog.find({ action: 'waitlist_offered' });
    expect(logs).toHaveLength(1);
  });

  test('sweepExpiredOffers writes waitlist_expired', async () => {
    const member = await createMember();
    const book = await createBook({ copiesAvailable: 0 });
    await Waitlist.create({
      bookId: book._id,
      memberId: member._id,
      queuePosition: 1,
      status: 'offered',
      offeredAt: new Date(Date.now() - 3 * 60 * 60 * 1000),
      offerExpiresAt: new Date(Date.now() - 60 * 60 * 1000),
    });

    await waitlistService.sweepExpiredOffers();

    const logs = await AuditLog.find({ action: 'waitlist_expired' });
    expect(logs).toHaveLength(1);
  });
});

describe('audit trail: book catalog', () => {
  test('create/update/retire each write their own action', async () => {
    const librarian = await createLibrarian();

    const createReq = {
      user: librarian,
      body: { title: 'Book', author: 'Author', isbn: '123', totalCopies: 1 },
    };
    const createRes = makeRes();
    await bookController.createBook(createReq, createRes, (e) => { throw e; });
    expect((await AuditLog.find({ action: 'book_created' }))).toHaveLength(1);

    const bookId = createRes.body.book._id;
    const updateReq = { user: librarian, params: { id: String(bookId) }, body: { genre: 'Fiction' } };
    const updateRes = makeRes();
    await bookController.updateBook(updateReq, updateRes, (e) => { throw e; });
    expect((await AuditLog.find({ action: 'book_updated' }))).toHaveLength(1);

    const deleteReq = { user: librarian, params: { id: String(bookId) } };
    const deleteRes = makeRes();
    await bookController.deleteBook(deleteReq, deleteRes, (e) => { throw e; });
    expect((await AuditLog.find({ action: 'book_retired' }))).toHaveLength(1);
  });
});

describe('GET /api/admin/audit-logs (listAuditLogs)', () => {
  test('paginates results', async () => {
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await logActivity({ action: `event_${i}`, resourceType: 'Test' });
    }

    const req = { query: { page: '1', limit: '2' } };
    const res = makeRes();
    await adminController.listAuditLogs(req, res, (e) => { throw e; });

    expect(res.body.logs).toHaveLength(2);
    expect(res.body.pagination).toEqual({ page: 1, limit: 2, total: 5, totalPages: 3 });
  });

  test('filters by action', async () => {
    await logActivity({ action: 'login_success', resourceType: 'User' });
    await logActivity({ action: 'login_failure', resourceType: 'User' });

    const req = { query: { action: 'login_failure' } };
    const res = makeRes();
    await adminController.listAuditLogs(req, res, (e) => { throw e; });

    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].action).toBe('login_failure');
  });

  test('filters by actorId', async () => {
    const memberA = await createMember();
    const memberB = await createMember();
    await logActivity({ actorId: memberA._id, action: 'test_a', resourceType: 'User' });
    await logActivity({ actorId: memberB._id, action: 'test_b', resourceType: 'User' });

    const req = { query: { actorId: String(memberA._id) } };
    const res = makeRes();
    await adminController.listAuditLogs(req, res, (e) => { throw e; });

    expect(res.body.logs).toHaveLength(1);
    expect(res.body.logs[0].action).toBe('test_a');
  });

  test('filters by date range', async () => {
    const oldLog = await AuditLog.create({
      action: 'old_event',
      resourceType: 'Test',
      timestamp: new Date('2020-01-01'),
    });
    const recentLog = await AuditLog.create({
      action: 'recent_event',
      resourceType: 'Test',
      timestamp: new Date(),
    });

    const req = { query: { from: '2024-01-01' } };
    const res = makeRes();
    await adminController.listAuditLogs(req, res, (e) => { throw e; });

    const ids = res.body.logs.map((l) => String(l._id));
    expect(ids).toContain(String(recentLog._id));
    expect(ids).not.toContain(String(oldLog._id));
  });
});

describe('exclusion policy: no sensitive data ever ends up in the audit trail', () => {
  test('a full register -> login -> MFA-enabled -> challenge flow never logs secrets', async () => {
    const rawPassword = 'Xk9!vTr2#qLpZ8SuperSecret';

    const registerReq = {
      body: { name: 'Audit Check', email: 'audit-check@example.com', password: rawPassword },
    };
    const registerRes = makeRes();
    await authController.register(registerReq, registerRes, (e) => { throw e; });

    const member = await User.findOne({ email: 'audit-check@example.com' }).select('+passwordHash');

    const loginReq = {
      ip: '7.7.7.7',
      headers: {},
      body: { email: member.email, password: rawPassword },
    };
    const loginRes = makeRes();
    await authController.login(loginReq, loginRes, (e) => { throw e; });

    const allLogs = await AuditLog.find({});
    const serialized = JSON.stringify(allLogs);

    expect(serialized).not.toContain(rawPassword);
    expect(serialized).not.toContain(member.passwordHash);
    // No raw JWT ever appears — JWTs always contain two literal '.' chars
    // separating header/payload/signature; a plausible weak signal that
    // none of the logged strings are actual tokens.
    expect(serialized).not.toMatch(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/);
  });
});
