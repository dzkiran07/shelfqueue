const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../src/models/User');
const AuditLog = require('../src/models/AuditLog');
const Book = require('../src/models/Book');
const Loan = require('../src/models/Loan');
const userController = require('../src/controllers/user.controller');
const adminController = require('../src/controllers/admin.controller');

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
    AuditLog.deleteMany({}),
    Book.deleteMany({}),
    Loan.deleteMany({}),
  ]);
});

function makeRes() {
  const res = {};
  res.headers = {};
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  res.setHeader = (name, value) => {
    res.headers[name] = value;
  };
  return res;
}

async function createMember(overrides = {}) {
  return User.create({
    name: 'Original Name',
    email: `member-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'irrelevant-for-this-test',
    role: 'member',
    ...overrides,
  });
}

describe('PATCH /api/users/me (mass assignment prevention)', () => {
  test("a member PATCHing role:'librarian' into their own profile update is silently ignored", async () => {
    const member = await createMember();

    const req = {
      user: member,
      body: { name: 'Updated Name', role: 'librarian' },
    };
    const res = makeRes();

    await userController.updateMe(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.user.name).toBe('Updated Name');
    expect(res.body.user.role).toBe('member'); // silently ignored, not rejected

    const reloaded = await User.findById(member._id);
    expect(reloaded.role).toBe('member');
  });

  test('status, mfaEnabled, and passwordHash are all stripped regardless of what is sent', async () => {
    const member = await createMember();
    const originalPasswordHash = 'irrelevant-for-this-test';

    const req = {
      user: member,
      body: {
        name: 'Still Me',
        status: 'suspended',
        mfaEnabled: true,
        passwordHash: 'attacker-supplied-hash',
      },
    };
    const res = makeRes();

    await userController.updateMe(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(200);

    const reloaded = await User.findById(member._id).select('+passwordHash');
    expect(reloaded.status).toBe('active');
    expect(reloaded.mfaEnabled).toBe(false);
    expect(reloaded.passwordHash).toBe(originalPasswordHash);
  });

  test('allowed fields (name, phone, notificationPreferences) do update', async () => {
    const member = await createMember();

    const req = {
      user: member,
      body: { name: 'New Name', phone: '+1 555 0100', notificationPreferences: { email: false } },
    };
    const res = makeRes();

    await userController.updateMe(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(200);
    const reloaded = await User.findById(member._id);
    expect(reloaded.name).toBe('New Name');
    expect(reloaded.phone).toBe('+1 555 0100');
    expect(reloaded.notificationPreferences.email).toBe(false);
  });

  test('rejects an empty name', async () => {
    const member = await createMember();
    const req = { user: member, body: { name: '   ' } };
    const res = makeRes();

    await userController.updateMe(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/users/me', () => {
  test('never exposes passwordHash or internal lockout bookkeeping', async () => {
    const member = await createMember({ failedLoginAttempts: 3, lockoutCount: 1 });
    const req = { user: member };
    const res = makeRes();

    await userController.getMe(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.user.passwordHash).toBeUndefined();
    expect(res.body.user.failedLoginAttempts).toBeUndefined();
    expect(res.body.user.lockoutCount).toBeUndefined();
    expect(res.body.user.email).toBe(member.email);
  });
});

describe('PATCH /api/admin/users/:id/role', () => {
  test('a librarian can change a member role, and it writes its own audit log entry', async () => {
    const librarian = await createMember({ role: 'librarian', email: 'lib@example.com' });
    const member = await createMember();

    const req = { user: librarian, params: { id: String(member._id) }, body: { role: 'librarian' }, ip: '1.2.3.4', headers: { 'user-agent': 'test-agent' } };
    const res = makeRes();

    await adminController.updateUserRole(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(200);
    const reloaded = await User.findById(member._id);
    expect(reloaded.role).toBe('librarian');

    const logs = await AuditLog.find({ resourceId: member._id });
    expect(logs).toHaveLength(1);
    expect(logs[0].action).toBe('role_change');
    expect(logs[0].actorId.toString()).toBe(String(librarian._id));
    expect(logs[0].metadata).toEqual({ previousRole: 'member', newRole: 'librarian' });
  });

  test('rejects an invalid role value', async () => {
    const librarian = await createMember({ role: 'librarian', email: 'lib2@example.com' });
    const member = await createMember();

    const req = { user: librarian, params: { id: String(member._id) }, body: { role: 'superadmin' } };
    const res = makeRes();

    await adminController.updateUserRole(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(400);
    const reloaded = await User.findById(member._id);
    expect(reloaded.role).toBe('member');
  });

  test('404s for a nonexistent target user', async () => {
    const librarian = await createMember({ role: 'librarian', email: 'lib3@example.com' });
    const req = {
      user: librarian,
      params: { id: new mongoose.Types.ObjectId().toString() },
      body: { role: 'librarian' },
    };
    const res = makeRes();

    await adminController.updateUserRole(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/users/me/export', () => {
  test('exports profile data and loan history, excluding sensitive/internal fields', async () => {
    const member = await createMember({ phone: '+1 555 0100' });
    const book = await Book.create({
      title: 'Test Book',
      author: 'Author',
      isbn: '000-0-00-000000-0',
      totalCopies: 1,
      copiesAvailable: 1,
    });
    await Loan.create({
      bookId: book._id,
      memberId: member._id,
      status: 'checked_out',
      memberNote: 'Loved this one',
      librarianNote: 'Member returned a previous book late — keep an eye on this one',
      conditionOnReturn: 'Good',
    });

    const req = { user: member };
    const res = makeRes();

    await userController.exportMyData(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(200);
    expect(res.body.profile.email).toBe(member.email);
    expect(res.body.profile.phone).toBe('+1 555 0100');
    expect(res.body.loans).toHaveLength(1);
    expect(res.body.loans[0].memberNote).toBe('Loved this one');

    // librarian-internal commentary must never appear in a member's own export
    expect(res.body.loans[0].librarianNote).toBeUndefined();

    // no sensitive/internal fields anywhere in the serialized payload
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain('mfaSecretEncrypted');
    expect(serialized).not.toContain('failedLoginAttempts');
    expect(serialized).not.toContain('lockoutCount');
    expect(serialized).not.toContain('irrelevant-for-this-test'); // the actual passwordHash value

    expect(res.headers['Content-Disposition']).toContain('attachment');
  });

  test('only exports the requesting user\'s own loans, not another member\'s', async () => {
    const memberA = await createMember();
    const memberB = await createMember();
    const book = await Book.create({
      title: 'Test Book',
      author: 'Author',
      isbn: '000-0-00-000000-0',
      totalCopies: 1,
      copiesAvailable: 1,
    });
    await Loan.create({ bookId: book._id, memberId: memberB._id, status: 'requested' });

    const req = { user: memberA };
    const res = makeRes();

    await userController.exportMyData(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.body.loans).toHaveLength(0);
  });
});

describe('POST /api/users/me/import', () => {
  test('restores allowed profile preferences from a valid import payload', async () => {
    const member = await createMember();
    const req = {
      user: member,
      body: { profile: { name: 'Restored Name', phone: '+44 20 7946 0958', notificationPreferences: { email: false } } },
    };
    const res = makeRes();

    await userController.importMyData(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(200);
    const reloaded = await User.findById(member._id);
    expect(reloaded.name).toBe('Restored Name');
    expect(reloaded.phone).toBe('+44 20 7946 0958');
    expect(reloaded.notificationPreferences.email).toBe(false);
  });

  test('rejects (does not silently strip) a role field smuggled into the profile object', async () => {
    const member = await createMember();
    const req = {
      user: member,
      body: { profile: { name: 'New Name', role: 'librarian' } },
    };
    const res = makeRes();

    await userController.importMyData(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(400);
    const reloaded = await User.findById(member._id);
    expect(reloaded.role).toBe('member');
    expect(reloaded.name).toBe('Original Name'); // whole request rejected, nothing applied
  });

  test('rejects an email field smuggled into the profile object', async () => {
    const member = await createMember();
    const req = {
      user: member,
      body: { profile: { email: 'attacker@example.com' } },
    };
    const res = makeRes();

    await userController.importMyData(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(400);
    const reloaded = await User.findById(member._id);
    expect(reloaded.email).toBe(member.email);
  });

  test('rejects a passwordHash field smuggled into the profile object', async () => {
    const member = await createMember();
    const req = {
      user: member,
      body: { profile: { passwordHash: 'attacker-supplied-hash' } },
    };
    const res = makeRes();

    await userController.importMyData(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(400);
  });

  test('rejects a full unmodified export file (extra top-level "loans" key) rather than silently ignoring it', async () => {
    const member = await createMember();
    const req = {
      user: member,
      body: {
        exportedAt: new Date().toISOString(),
        profile: { name: 'New Name' },
        loans: [{ id: '1', status: 'requested' }],
      },
    };
    const res = makeRes();

    await userController.importMyData(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(400);
  });

  test('rejects a payload missing the profile object entirely', async () => {
    const member = await createMember();
    const req = { user: member, body: { name: 'New Name' } };
    const res = makeRes();

    await userController.importMyData(req, res, (err) => {
      throw err || new Error('unexpected next() call');
    });

    expect(res.statusCode).toBe(400);
  });
});
