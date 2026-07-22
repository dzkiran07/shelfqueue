module.exports = {
  testEnvironment: 'node',
  // A handful of integration tests exercise real code paths that send mail
  // through the Ethereal sandbox SMTP server (see src/services/emailService.js);
  // that round trip alone can take longer than Jest's 5s default, which made
  // those tests flaky in CI. 20s gives real network I/O headroom without
  // letting a genuinely hung test run forever.
  testTimeout: 20000,
  // tests/auth.test.js is a pre-existing empty placeholder (0 bytes,
  // untracked) — Jest treats a test file with zero tests as a hard failure.
  // Excluded here rather than deleted/populated, since that file's actual
  // auth-test content isn't this phase's call to make.
  testPathIgnorePatterns: ['/node_modules/', '<rootDir>/tests/auth.test.js'],
};
