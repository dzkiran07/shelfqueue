process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.CSRF_SECRET = process.env.CSRF_SECRET || 'test-csrf-secret';

const tokenService = require('../src/services/tokenService');
const { csrfProtection, issueCsrfToken, generateCsrfToken, getSessionId } = require('../src/middleware/csrf');

function makeReq({ method = 'POST', refreshToken, csrfToken } = {}) {
  return {
    method,
    cookies: refreshToken ? { [tokenService.REFRESH_TOKEN_COOKIE]: refreshToken } : {},
    headers: csrfToken ? { 'x-csrf-token': csrfToken } : {},
  };
}

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

function signRefreshTokenFor(userId, familyId, jti = 'jti-1') {
  // Bypasses tokenService.issueSession (which needs Redis) — these tests
  // only care about the JWT's familyId claim, which is all csrf.js reads.
  const jwt = require('jsonwebtoken');
  return jwt.sign({ sub: userId, familyId, jti, type: 'refresh' }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: '30d',
  });
}

describe('csrfProtection', () => {
  test('a state-changing request with a valid session but no X-CSRF-Token header is rejected with 403', () => {
    const refreshToken = signRefreshTokenFor('user1', 'family-A');
    const req = makeReq({ method: 'POST', refreshToken });
    const res = makeRes();
    let nextCalled = false;

    csrfProtection(req, res, () => {
      nextCalled = true;
    });

    expect(res.statusCode).toBe(403);
    expect(nextCalled).toBe(false);
  });

  test('a token generated for one session is rejected when submitted alongside a different session\'s cookie', () => {
    const sessionAId = 'family-A';
    const sessionBRefreshToken = signRefreshTokenFor('user2', 'family-B');

    const tokenForSessionA = generateCsrfToken(sessionAId);

    const req = makeReq({
      method: 'POST',
      refreshToken: sessionBRefreshToken, // this request is authenticated as session B...
      csrfToken: tokenForSessionA, // ...but presents a token minted for session A
    });
    const res = makeRes();
    let nextCalled = false;

    csrfProtection(req, res, () => {
      nextCalled = true;
    });

    expect(res.statusCode).toBe(403);
    expect(res.body.error).toMatch(/invalid csrf token/i);
    expect(nextCalled).toBe(false);
  });

  test('a correctly matching token for the requester\'s own session is accepted', () => {
    const refreshToken = signRefreshTokenFor('user3', 'family-C');
    const validToken = generateCsrfToken('family-C');

    const req = makeReq({ method: 'PATCH', refreshToken, csrfToken: validToken });
    const res = makeRes();
    let nextCalled = false;

    csrfProtection(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });

  test('GET requests are never checked, even with a session and no token', () => {
    const refreshToken = signRefreshTokenFor('user4', 'family-D');
    const req = makeReq({ method: 'GET', refreshToken });
    const res = makeRes();
    let nextCalled = false;

    csrfProtection(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });

  test('a request with no session at all (e.g. login) passes through untouched', () => {
    const req = makeReq({ method: 'POST' }); // no refresh cookie, no csrf token
    const res = makeRes();
    let nextCalled = false;

    csrfProtection(req, res, () => {
      nextCalled = true;
    });

    expect(nextCalled).toBe(true);
    expect(res.statusCode).toBeUndefined();
  });

  test('an expired/garbage refresh cookie is treated as "no session", not a crash', () => {
    const req = makeReq({ method: 'POST', refreshToken: 'not-a-real-jwt' });
    const res = makeRes();
    let nextCalled = false;

    expect(() => csrfProtection(req, res, () => {
      nextCalled = true;
    })).not.toThrow();

    expect(nextCalled).toBe(true);
  });
});

describe('issueCsrfToken (GET /api/csrf-token)', () => {
  test('issues a token when a valid session exists', () => {
    const refreshToken = signRefreshTokenFor('user5', 'family-E');
    const req = { cookies: { [tokenService.REFRESH_TOKEN_COOKIE]: refreshToken } };
    const res = makeRes();

    issueCsrfToken(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.csrfToken).toBe(generateCsrfToken('family-E'));
  });

  test('rejects with 401 when there is no session', () => {
    const req = { cookies: {} };
    const res = makeRes();

    issueCsrfToken(req, res);

    expect(res.statusCode).toBe(401);
  });
});

describe('getSessionId', () => {
  test('returns null for a missing refresh cookie', () => {
    expect(getSessionId({ cookies: {} })).toBeNull();
  });

  test('returns the familyId for a valid refresh cookie', () => {
    const refreshToken = signRefreshTokenFor('user6', 'family-F');
    expect(getSessionId({ cookies: { [tokenService.REFRESH_TOKEN_COOKIE]: refreshToken } })).toBe(
      'family-F'
    );
  });
});
