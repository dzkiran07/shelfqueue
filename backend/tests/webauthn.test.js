process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.CSRF_SECRET = process.env.CSRF_SECRET || 'test-csrf-secret';

// Real WebAuthn verification requires genuine cryptographic ceremony data
// (an actual authenticator's signed attestation/assertion) that isn't
// practical to fabricate by hand in a unit test. generateRegistrationOptions
// and generateAuthenticationOptions get a lightweight, realistic-shaped fake
// implementation; verifyRegistrationResponse/verifyAuthenticationResponse
// are left as directly-controllable mocks so each test can drive a specific
// success/failure outcome. This tests all of THIS app's actual logic —
// challenge storage/consumption via Redis, enumeration-safety response
// shaping, credential persistence, duplicate detection, session issuance,
// MFA branching, and signature-counter persistence ordering — while the
// underlying cryptographic verification itself is delegated to (and already
// tested by) @simplewebauthn/server, not re-verified here.
jest.mock('@simplewebauthn/server', () => ({
  generateRegistrationOptions: jest.fn(async (opts) => ({
    challenge: 'mock-registration-challenge',
    rp: { name: opts.rpName, id: opts.rpID },
    user: { id: Buffer.from(opts.userID).toString('base64url'), name: opts.userName },
    pubKeyCredParams: [{ alg: -7, type: 'public-key' }],
    excludeCredentials: opts.excludeCredentials || [],
  })),
  verifyRegistrationResponse: jest.fn(),
  generateAuthenticationOptions: jest.fn(async (opts) => ({
    challenge: 'mock-authentication-challenge',
    allowCredentials: opts.allowCredentials || [],
    rpId: opts.rpID,
  })),
  verifyAuthenticationResponse: jest.fn(),
}));

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} = require('@simplewebauthn/server');
const User = require('../src/models/User');
const AuditLog = require('../src/models/AuditLog');
const authController = require('../src/controllers/auth.controller');
const webauthnService = require('../src/services/webauthnService');

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const { redisClient } = require('../src/config/redis');
  const store = new Map();
  redisClient.get = async (key) => (store.has(key) ? store.get(key) : null);
  redisClient.set = async (key, val) => {
    store.set(key, val);
    return 'OK';
  };
  redisClient.del = async (key) => {
    const existed = store.delete(key);
    return existed ? 1 : 0;
  };
  const sets = new Map();
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
  redisClient.expire = async () => 1;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await Promise.all([User.deleteMany({}), AuditLog.deleteMany({})]);
  jest.clearAllMocks();
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

describe('POST /api/auth/webauthn/register-options', () => {
  test('returns options and excludes already-enrolled credentials', async () => {
    const member = await createMember({
      webauthnCredentials: [
        { credentialId: 'existing-cred-1', publicKey: 'abc', counter: 0, transports: ['internal'] },
      ],
    });

    const req = { user: member };
    const res = makeRes();
    await authController.webauthnRegisterOptions(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.challenge).toBe('mock-registration-challenge');
    expect(res.body.excludeCredentials).toEqual([{ id: 'existing-cred-1', transports: ['internal'] }]);
  });
});

describe('POST /api/auth/webauthn/register-verify', () => {
  test('a verified registration is persisted to webauthnCredentials', async () => {
    const member = await createMember();
    await webauthnService.buildRegistrationOptions(member); // establishes the stored challenge

    verifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'new-credential-id',
          publicKey: new Uint8Array([1, 2, 3, 4]),
          counter: 0,
          transports: ['internal', 'hybrid'],
        },
      },
    });

    const req = {
      user: member,
      body: { response: { id: 'new-credential-id' }, deviceLabel: '<script>x</script>My Phone' },
    };
    const res = makeRes();
    await authController.webauthnRegisterVerify(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(201);

    const reloaded = await User.findById(member._id);
    expect(reloaded.webauthnCredentials).toHaveLength(1);
    expect(reloaded.webauthnCredentials[0].credentialId).toBe('new-credential-id');
    expect(reloaded.webauthnCredentials[0].publicKey).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
    expect(reloaded.webauthnCredentials[0].deviceLabel).not.toContain('<script');
    expect(reloaded.webauthnCredentials[0].deviceLabel).toContain('My Phone');

    const logs = await AuditLog.find({ action: 'webauthn_credential_registered' });
    expect(logs).toHaveLength(1);
  });

  test('rejects when the underlying verification fails', async () => {
    const member = await createMember();
    await webauthnService.buildRegistrationOptions(member);

    verifyRegistrationResponse.mockResolvedValueOnce({ verified: false });

    const req = { user: member, body: { response: { id: 'whatever' } } };
    const res = makeRes();
    await authController.webauthnRegisterVerify(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(400);
    const reloaded = await User.findById(member._id);
    expect(reloaded.webauthnCredentials).toHaveLength(0);
  });

  test('rejects if the challenge was never issued (or already used)', async () => {
    const member = await createMember();
    // Deliberately skip buildRegistrationOptions — no challenge stored.

    const req = { user: member, body: { response: { id: 'whatever' } } };
    const res = makeRes();
    await authController.webauthnRegisterVerify(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(400);
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  test('rejects re-registering the same physical authenticator (duplicate credentialId)', async () => {
    const member = await createMember({
      webauthnCredentials: [{ credentialId: 'dup-cred', publicKey: 'abc', counter: 0 }],
    });
    await webauthnService.buildRegistrationOptions(member);

    verifyRegistrationResponse.mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: { id: 'dup-cred', publicKey: new Uint8Array([9]), counter: 0, transports: [] },
      },
    });

    const req = { user: member, body: { response: { id: 'dup-cred' } } };
    const res = makeRes();
    await authController.webauthnRegisterVerify(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(409);
    const reloaded = await User.findById(member._id);
    expect(reloaded.webauthnCredentials).toHaveLength(1); // unchanged
  });
});

describe('POST /api/auth/webauthn/login-options (enumeration safety)', () => {
  test('an account with enrolled credentials gets a populated allowCredentials list', async () => {
    const member = await createMember({
      webauthnCredentials: [{ credentialId: 'my-passkey', publicKey: 'abc', counter: 0, transports: ['internal'] }],
    });

    const req = { body: { email: member.email } };
    const res = makeRes();
    await authController.webauthnLoginOptions(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.allowCredentials).toEqual([{ id: 'my-passkey', transports: ['internal'] }]);
  });

  test('a nonexistent account gets the identically-shaped response (empty allowCredentials, same status)', async () => {
    const existingMember = await createMember({
      webauthnCredentials: [{ credentialId: 'my-passkey', publicKey: 'abc', counter: 0 }],
    });

    const resExisting = makeRes();
    await authController.webauthnLoginOptions(
      { body: { email: existingMember.email } },
      resExisting,
      (e) => { throw e; }
    );

    const resNonexistent = makeRes();
    await authController.webauthnLoginOptions(
      { body: { email: 'nobody-at-all@example.com' } },
      resNonexistent,
      (e) => { throw e; }
    );

    // Same status code, same response shape (just empty allowCredentials)
    // — a caller can't distinguish "no such account" from "account exists
    // but has no passkeys" by looking at this response.
    expect(resNonexistent.statusCode).toBe(resExisting.statusCode);
    expect(Object.keys(resNonexistent.body).sort()).toEqual(Object.keys(resExisting.body).sort());
    expect(resNonexistent.body.allowCredentials).toEqual([]);
  });
});

describe('POST /api/auth/webauthn/login-verify', () => {
  test('a successful passkey login (no MFA) issues a session', async () => {
    const member = await createMember({
      webauthnCredentials: [{ credentialId: 'my-passkey', publicKey: Buffer.from([1, 2]).toString('base64'), counter: 5 }],
    });
    await webauthnService.buildAuthenticationOptions(member, member.email);

    verifyAuthenticationResponse.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 6 },
    });

    const req = { ip: '1.1.1.1', headers: {}, body: { email: member.email, response: { id: 'my-passkey' } } };
    const res = makeRes();
    await authController.webauthnLoginVerify(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.user.email).toBe(member.email);

    const reloaded = await User.findById(member._id);
    expect(reloaded.webauthnCredentials[0].counter).toBe(6); // bumped

    const logs = await AuditLog.find({ action: 'webauthn_login_success' });
    expect(logs).toHaveLength(1);
    const loginLogs = await AuditLog.find({ action: 'login_success' });
    expect(loginLogs).toHaveLength(1);
  });

  test('an MFA-enabled account gets mfaRequired instead of a session', async () => {
    const member = await createMember({
      mfaEnabled: true,
      mfaSecretEncrypted: 'irrelevant-should-not-be-reached',
      webauthnCredentials: [{ credentialId: 'my-passkey', publicKey: Buffer.from([1]).toString('base64'), counter: 0 }],
    });
    await webauthnService.buildAuthenticationOptions(member, member.email);

    verifyAuthenticationResponse.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 1 },
    });

    const req = { ip: '1.1.1.2', headers: {}, body: { email: member.email, response: { id: 'my-passkey' } } };
    const res = makeRes();
    await authController.webauthnLoginVerify(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.mfaRequired).toBe(true);
    expect(res.body.mfaPendingToken).toBeTruthy();
    expect(res.body.user).toBeUndefined();
  });

  test('persists the bumped counter even when the account is suspended', async () => {
    const member = await createMember({
      status: 'suspended',
      webauthnCredentials: [{ credentialId: 'my-passkey', publicKey: Buffer.from([1]).toString('base64'), counter: 3 }],
    });
    await webauthnService.buildAuthenticationOptions(member, member.email);

    verifyAuthenticationResponse.mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 4 },
    });

    const req = { ip: '1.1.1.3', headers: {}, body: { email: member.email, response: { id: 'my-passkey' } } };
    const res = makeRes();
    await authController.webauthnLoginVerify(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(403);
    const reloaded = await User.findById(member._id);
    expect(reloaded.webauthnCredentials[0].counter).toBe(4); // still persisted
  });

  test('an unrecognized credential id and a nonexistent account get the identical generic failure', async () => {
    const member = await createMember({
      webauthnCredentials: [{ credentialId: 'my-passkey', publicKey: 'abc', counter: 0 }],
    });
    await webauthnService.buildAuthenticationOptions(member, member.email);

    const resWrongCred = makeRes();
    await authController.webauthnLoginVerify(
      { ip: '1.1.1.4', headers: {}, body: { email: member.email, response: { id: 'someone-elses-cred' } } },
      resWrongCred,
      (e) => { throw e; }
    );

    const resNoAccount = makeRes();
    await authController.webauthnLoginVerify(
      { ip: '1.1.1.5', headers: {}, body: { email: 'nobody@example.com', response: { id: 'anything' } } },
      resNoAccount,
      (e) => { throw e; }
    );

    expect(resWrongCred.statusCode).toBe(401);
    expect(resNoAccount.statusCode).toBe(401);
    expect(resWrongCred.body).toEqual(resNoAccount.body);
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled(); // never reached — failed before crypto verification
  });

  test('rejects when the underlying verification fails', async () => {
    const member = await createMember({
      webauthnCredentials: [{ credentialId: 'my-passkey', publicKey: 'abc', counter: 0 }],
    });
    await webauthnService.buildAuthenticationOptions(member, member.email);

    verifyAuthenticationResponse.mockResolvedValueOnce({ verified: false });

    const req = { ip: '1.1.1.6', headers: {}, body: { email: member.email, response: { id: 'my-passkey' } } };
    const res = makeRes();
    await authController.webauthnLoginVerify(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(401);
  });
});
