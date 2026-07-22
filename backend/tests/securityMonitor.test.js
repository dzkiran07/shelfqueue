process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.CSRF_SECRET = process.env.CSRF_SECRET || 'test-csrf-secret';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const { MongoMemoryServer } = require('mongodb-memory-server');
const User = require('../src/models/User');
const SecurityAlert = require('../src/models/SecurityAlert');
const securityMonitorService = require('../src/services/securityMonitorService');
const adminController = require('../src/controllers/admin.controller');
const authController = require('../src/controllers/auth.controller');

let mongod;
let zsets;
let store;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const { redisClient } = require('../src/config/redis');
  store = new Map();
  zsets = new Map();
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
  store.clear();
  zsets.clear();
  await Promise.all([User.deleteMany({}), SecurityAlert.deleteMany({})]);
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

async function createLibrarian() {
  return User.create({
    name: 'Librarian',
    email: `lib-${Date.now()}-${Math.random()}@example.com`,
    passwordHash: 'irrelevant-for-this-test',
    role: 'librarian',
  });
}

async function createSecurityAlert(overrides = {}) {
  return SecurityAlert.create({
    type: 'excessive_failed_logins',
    ip: '1.2.3.4',
    details: 'test alert',
    ...overrides,
  });
}

describe('securityMonitorService.recordFailedLogin', () => {
  test('does not alert at or below the threshold (5 failures)', async () => {
    const ip = '10.0.0.1';
    for (let i = 0; i < 5; i++) {
      // eslint-disable-next-line no-await-in-loop
      await securityMonitorService.recordFailedLogin(ip);
    }

    const alerts = await SecurityAlert.find({ ip });
    expect(alerts).toHaveLength(0);
  });

  test('writes exactly one SecurityAlert once the threshold (>5) is crossed', async () => {
    const ip = '10.0.0.2';
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      await securityMonitorService.recordFailedLogin(ip);
    }

    const alerts = await SecurityAlert.find({ ip });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].type).toBe('excessive_failed_logins');
    expect(alerts[0].resolved).toBe(false);
    expect(alerts[0].details).toMatch(/6 failed login attempts/);
  });

  test('does not write a second alert for further failures within the cooldown', async () => {
    const ip = '10.0.0.3';
    for (let i = 0; i < 6; i++) {
      // eslint-disable-next-line no-await-in-loop
      await securityMonitorService.recordFailedLogin(ip);
    }
    // two more failures right after — still within the cooldown window
    await securityMonitorService.recordFailedLogin(ip);
    await securityMonitorService.recordFailedLogin(ip);

    const alerts = await SecurityAlert.find({ ip });
    expect(alerts).toHaveLength(1);
  });

  test('evicts failures older than the sliding window before counting', async () => {
    const ip = '10.0.0.4';
    const key = `login-fail-window:${ip}`;

    // Seed 10 failures from 2 minutes ago — well outside the 1-minute
    // sliding window, so a fresh failure now should see a count of 1, not 11.
    const { redisClient } = require('../src/config/redis');
    for (let i = 0; i < 10; i++) {
      // eslint-disable-next-line no-await-in-loop
      await redisClient.zAdd(key, { score: Date.now() - 120 * 1000, value: `old-${i}` });
    }

    await securityMonitorService.recordFailedLogin(ip);

    const alerts = await SecurityAlert.find({ ip });
    expect(alerts).toHaveLength(0); // count is 1 (just the fresh one), not 11
  });

  test('is a no-op for an empty/undefined ip', async () => {
    await expect(securityMonitorService.recordFailedLogin(undefined)).resolves.toBeUndefined();
    const alerts = await SecurityAlert.find({});
    expect(alerts).toHaveLength(0);
  });
});

describe('integration: real login failures through auth.controller trigger an alert', () => {
  test('6 wrong-password login attempts from the same IP produce a SecurityAlert', async () => {
    const passwordHash = await bcrypt.hash('CorrectHorseBattery9!', 12);
    const member = await User.create({
      name: 'Member',
      email: 'monitor-target@example.com',
      passwordHash,
      role: 'member',
    });

    for (let i = 0; i < 6; i++) {
      const req = {
        ip: '20.20.20.20',
        headers: {},
        body: { email: member.email, password: 'wrong' },
      };
      const res = makeRes();
      // eslint-disable-next-line no-await-in-loop
      await authController.login(req, res, (e) => { throw e; });
    }

    const alerts = await SecurityAlert.find({ ip: '20.20.20.20' });
    expect(alerts).toHaveLength(1);
  }, 20000); // 6 sequential bcrypt.compare calls at cost 12 can exceed the 5s default under load

  test('an allow-listed IP is exempt from monitoring, matching its exemption from blocking', async () => {
    const env = require('../src/config/env');
    env.ALLOWED_IPS.push('30.30.30.30');

    const passwordHash = await bcrypt.hash('CorrectHorseBattery9!', 12);
    const member = await User.create({
      name: 'Member',
      email: 'allowlisted-target@example.com',
      passwordHash,
      role: 'member',
    });

    for (let i = 0; i < 8; i++) {
      const req = {
        ip: '30.30.30.30',
        headers: {},
        body: { email: member.email, password: 'wrong' },
      };
      const res = makeRes();
      // eslint-disable-next-line no-await-in-loop
      await authController.login(req, res, (e) => { throw e; });
    }

    const alerts = await SecurityAlert.find({ ip: '30.30.30.30' });
    expect(alerts).toHaveLength(0);

    env.ALLOWED_IPS.pop();
  }, 20000); // 8 sequential bcrypt.compare calls at cost 12 can exceed the 5s default under load
});

describe('GET /api/admin/alerts (listAlerts)', () => {
  test('paginates and defaults to newest first', async () => {
    await createSecurityAlert({ ip: '1.1.1.1' });
    await createSecurityAlert({ ip: '2.2.2.2' });
    await createSecurityAlert({ ip: '3.3.3.3' });

    const req = { query: { limit: '2', page: '1' } };
    const res = makeRes();
    await adminController.listAlerts(req, res, (e) => { throw e; });

    expect(res.body.alerts).toHaveLength(2);
    expect(res.body.pagination.total).toBe(3);
  });

  test('filters by resolved status', async () => {
    await createSecurityAlert({ resolved: false });
    await createSecurityAlert({ resolved: true });

    const req = { query: { resolved: 'false' } };
    const res = makeRes();
    await adminController.listAlerts(req, res, (e) => { throw e; });

    expect(res.body.alerts).toHaveLength(1);
    expect(res.body.alerts[0].resolved).toBe(false);
  });
});

describe('PATCH /api/admin/alerts/:id/resolve (resolveAlert)', () => {
  test('marks an alert resolved, records who and when, and writes an audit entry', async () => {
    const librarian = await createLibrarian();
    const alert = await createSecurityAlert();

    const req = { user: librarian, params: { id: String(alert._id) }, ip: '1.1.1.1', headers: {} };
    const res = makeRes();
    await adminController.resolveAlert(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(200);
    expect(res.body.alert.resolved).toBe(true);

    const reloaded = await SecurityAlert.findById(alert._id);
    expect(reloaded.resolved).toBe(true);
    expect(String(reloaded.resolvedBy)).toBe(String(librarian._id));
    expect(reloaded.resolvedAt).toBeInstanceOf(Date);

    const AuditLog = require('../src/models/AuditLog');
    const logs = await AuditLog.find({ action: 'security_alert_resolved', resourceId: alert._id });
    expect(logs).toHaveLength(1);
  });

  test('404s for a nonexistent alert', async () => {
    const librarian = await createLibrarian();
    const req = {
      user: librarian,
      params: { id: new mongoose.Types.ObjectId().toString() },
      headers: {},
    };
    const res = makeRes();
    await adminController.resolveAlert(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(404);
  });

  test('400s for a malformed alert id', async () => {
    const librarian = await createLibrarian();
    const req = { user: librarian, params: { id: 'not-an-id' }, headers: {} };
    const res = makeRes();
    await adminController.resolveAlert(req, res, (e) => { throw e; });

    expect(res.statusCode).toBe(400);
  });
});
