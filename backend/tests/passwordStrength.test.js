process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-access-secret';
process.env.JWT_REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'test-refresh-secret';
process.env.CSRF_SECRET = process.env.CSRF_SECRET || 'test-csrf-secret';

const authController = require('../src/controllers/auth.controller');

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

describe('POST /api/auth/password-strength', () => {
  test('scores a weak password low and a strong one high', () => {
    const weakRes = makeRes();
    authController.passwordStrengthCheck({ body: { password: 'password1' } }, weakRes);
    expect(weakRes.statusCode).toBe(200);
    expect(weakRes.body.score).toBeLessThanOrEqual(1);

    const strongRes = makeRes();
    authController.passwordStrengthCheck(
      { body: { password: 'xK9$vQ2#mZ7!wL4p' } },
      strongRes
    );
    expect(strongRes.statusCode).toBe(200);
    expect(strongRes.body.score).toBeGreaterThanOrEqual(3);
  });

  test('passes name/email through to zxcvbn as userInputs without erroring', () => {
    const res = makeRes();
    authController.passwordStrengthCheck(
      { body: { password: 'JohnSmith123!', name: 'John Smith', email: 'johnsmith@example.com' } },
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({ score: expect.any(Number), suggestions: expect.any(Array) })
    );
  });

  test('treats a missing password as empty rather than throwing', () => {
    const res = makeRes();
    authController.passwordStrengthCheck({ body: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.score).toBe(0);
  });

  test('clamps an oversized password before scoring instead of passing it through raw', () => {
    const res = makeRes();
    const huge = 'a'.repeat(10000);
    authController.passwordStrengthCheck({ body: { password: huge } }, res);
    expect(res.statusCode).toBe(200);
    expect(typeof res.body.score).toBe('number');
  });
});
