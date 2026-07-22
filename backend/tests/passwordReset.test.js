process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.CSRF_SECRET = process.env.CSRF_SECRET || 'test-csrf-secret';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../src/models/User');
const authController = require('../src/controllers/auth.controller');
const passwordResetService = require('../src/services/passwordResetService');
const emailService = require('../src/services/emailService');
const tokenService = require('../src/services/tokenService');

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

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
  await User.deleteMany({});
  jest.restoreAllMocks();
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

async function createMemberWithPassword(rawPassword, overrides = {}) {
  const passwordHash = await bcrypt.hash(rawPassword, 12);
  return User.create({
    name: 'Member',
    email: `member-${Date.now()}-${Math.random()}@example.com`,
    passwordHash,
    passwordHistory: [passwordHash],
    passwordChangedAt: new Date(),
    role: 'member',
    ...overrides,
  });
}

describe('POST /api/auth/forgot-password', () => {
  test('returns the same generic response for an existing account', async () => {
    jest.spyOn(emailService, 'sendPasswordResetEmail').mockResolvedValue({ previewUrl: 'http://preview' });
    const member = await createMemberWithPassword('CorrectHorseBattery9!');

    const req = { body: { email: member.email } };
    const res = makeRes();
    await authController.forgotPassword(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toMatch(/if an account with that email exists/i);
  });

  test('returns the identical response for a nonexistent account (no enumeration)', async () => {
    const req = { body: { email: 'nobody-at-all@example.com' } };
    const res = makeRes();
    await authController.forgotPassword(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.message).toMatch(/if an account with that email exists/i);
  });

  test('actually sends an email (via a mocked emailService) and logs a preview URL for an existing account', async () => {
    const sendSpy = jest
      .spyOn(emailService, 'sendPasswordResetEmail')
      .mockResolvedValue({ previewUrl: 'http://ethereal.example/preview/1' });
    const member = await createMemberWithPassword('CorrectHorseBattery9!');

    const req = { body: { email: member.email } };
    const res = makeRes();
    await authController.forgotPassword(req, res, (e) => { throw e; });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(sendSpy.mock.calls[0][0]).toBe(member.email);
    expect(sendSpy.mock.calls[0][1]).toContain('/reset-password/');
  });

  test('an email-sending failure still returns the generic 200 (never leaks a failure)', async () => {
    jest.spyOn(emailService, 'sendPasswordResetEmail').mockRejectedValue(new Error('SMTP down'));
    const member = await createMemberWithPassword('CorrectHorseBattery9!');

    const req = { body: { email: member.email } };
    const res = makeRes();
    await authController.forgotPassword(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
  });

  test('a second forgot-password request invalidates the first token', async () => {
    jest.spyOn(emailService, 'sendPasswordResetEmail').mockImplementation(async () => ({}));
    const member = await createMemberWithPassword('CorrectHorseBattery9!');

    const firstToken = await passwordResetService.createResetToken(member._id);
    const secondToken = await passwordResetService.createResetToken(member._id);

    const firstResult = await passwordResetService.consumeResetToken(firstToken);
    const secondResult = await passwordResetService.consumeResetToken(secondToken);

    expect(firstResult).toBeNull(); // invalidated by the second request
    expect(secondResult).toBe(String(member._id));
  });
});

describe('POST /api/auth/reset-password/:token', () => {
  test('resets the password with a valid token and a policy-compliant new password', async () => {
    const member = await createMemberWithPassword('OldPassword9!Xyz');
    const rawToken = await passwordResetService.createResetToken(member._id);

    const req = { params: { token: rawToken }, body: { password: 'BrandNewPassw0rd!Zz' } };
    const res = makeRes();
    await authController.resetPassword(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);

    const reloaded = await User.findById(member._id).select('+passwordHash +passwordHistory');
    const matches = await bcrypt.compare('BrandNewPassw0rd!Zz', reloaded.passwordHash);
    expect(matches).toBe(true);
    expect(reloaded.passwordHistory).toHaveLength(2);
    expect(reloaded.passwordChangedAt.getTime()).toBeGreaterThan(member.passwordChangedAt.getTime());
  });

  test('the token is single-use: a second attempt with the same token fails', async () => {
    const member = await createMemberWithPassword('OldPassword9!Xyz');
    const rawToken = await passwordResetService.createResetToken(member._id);

    const req1 = { params: { token: rawToken }, body: { password: 'BrandNewPassw0rd!Zz' } };
    const res1 = makeRes();
    await authController.resetPassword(req1, res1, (e) => { throw e; });
    expect(res1.statusCode).toBe(200);

    const req2 = { params: { token: rawToken }, body: { password: 'AnotherOne9!Abcd' } };
    const res2 = makeRes();
    await authController.resetPassword(req2, res2, (e) => { throw e; });
    expect(res2.statusCode).toBe(400);
  });

  test('rejects an invalid/unknown token', async () => {
    const req = { params: { token: 'not-a-real-token' }, body: { password: 'BrandNewPassw0rd!Zz' } };
    const res = makeRes();
    await authController.resetPassword(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(400);
  });

  test('enforces the same password policy as registration (e.g. too short)', async () => {
    const member = await createMemberWithPassword('OldPassword9!Xyz');
    const rawToken = await passwordResetService.createResetToken(member._id);

    const req = { params: { token: rawToken }, body: { password: 'short1!' } };
    const res = makeRes();
    await authController.resetPassword(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(400);
    expect(res.body.errors.length).toBeGreaterThan(0);
  });

  test('rejects reusing the same password via history', async () => {
    const member = await createMemberWithPassword('ReusedPassw0rd!Zz');
    const rawToken = await passwordResetService.createResetToken(member._id);

    const req = { params: { token: rawToken }, body: { password: 'ReusedPassw0rd!Zz' } };
    const res = makeRes();
    await authController.resetPassword(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(400);
  });

  test('clears any account lockout state on a successful reset', async () => {
    const member = await createMemberWithPassword('OldPassword9!Xyz', {
      failedLoginAttempts: 5,
      lockoutUntil: new Date(Date.now() + 60 * 60 * 1000),
      lockoutCount: 2,
    });
    const rawToken = await passwordResetService.createResetToken(member._id);

    const req = { params: { token: rawToken }, body: { password: 'BrandNewPassw0rd!Zz' } };
    const res = makeRes();
    await authController.resetPassword(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    const reloaded = await User.findById(member._id);
    expect(reloaded.failedLoginAttempts).toBe(0);
    expect(reloaded.lockoutUntil).toBeNull();
  });

  test('revokes all existing sessions on a successful reset', async () => {
    const member = await createMemberWithPassword('OldPassword9!Xyz');
    await tokenService.issueSession(member._id, { userAgent: 'device-A' });
    await tokenService.issueSession(member._id, { userAgent: 'device-B' });

    const beforeSessions = await tokenService.listSessions(member._id);
    expect(beforeSessions).toHaveLength(2);

    const rawToken = await passwordResetService.createResetToken(member._id);
    const req = { params: { token: rawToken }, body: { password: 'BrandNewPassw0rd!Zz' } };
    const res = makeRes();
    await authController.resetPassword(req, res, (e) => { throw e; });

    const afterSessions = await tokenService.listSessions(member._id);
    expect(afterSessions).toHaveLength(0);
  });
});

describe('login password expiry enforcement', () => {
  test('a password older than PASSWORD_EXPIRY_DAYS is rejected with passwordExpired:true', async () => {
    const env = require('../src/config/env');
    const oldDate = new Date(Date.now() - (env.PASSWORD_EXPIRY_DAYS + 1) * 24 * 60 * 60 * 1000);
    const member = await createMemberWithPassword('CorrectHorseBattery9!', {
      passwordChangedAt: oldDate,
    });

    const req = {
      ip: '9.9.9.9',
      headers: {},
      body: { email: member.email, password: 'CorrectHorseBattery9!' },
    };
    const res = makeRes();
    await authController.login(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(403);
    expect(res.body.passwordExpired).toBe(true);
    expect(res.cookiesSet).toBeUndefined();
  });

  test('a password within the expiry window logs in normally', async () => {
    const member = await createMemberWithPassword('CorrectHorseBattery9!', {
      passwordChangedAt: new Date(), // just changed
    });

    const req = {
      ip: '9.9.9.8',
      headers: {},
      body: { email: member.email, password: 'CorrectHorseBattery9!' },
    };
    const res = makeRes();
    await authController.login(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.user.email).toBe(member.email);
  });

  test('an expired password blocks login even when MFA is enabled', async () => {
    const env = require('../src/config/env');
    const oldDate = new Date(Date.now() - (env.PASSWORD_EXPIRY_DAYS + 5) * 24 * 60 * 60 * 1000);
    const member = await createMemberWithPassword('CorrectHorseBattery9!', {
      passwordChangedAt: oldDate,
      mfaEnabled: true,
      mfaSecretEncrypted: 'irrelevant-should-never-be-reached',
    });

    const req = {
      ip: '9.9.9.7',
      headers: {},
      body: { email: member.email, password: 'CorrectHorseBattery9!' },
    };
    const res = makeRes();
    await authController.login(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(403);
    expect(res.body.passwordExpired).toBe(true);
    expect(res.body.mfaRequired).toBeUndefined();
  });
});
