const bcrypt = require('bcryptjs');
const zxcvbn = require('zxcvbn');

const MIN_LENGTH = 12;
const BCRYPT_COST_FACTOR = 12;
const HISTORY_LIMIT = 5;

// Small, deliberately short blocklist — the point isn't exhaustive coverage
// (a real deployment would use a proper breached-password list like
// Have I Been Pwned's range API), it's rejecting the obvious ones a strength
// meter alone wouldn't necessarily flag as "weak" on length/character mix.
const COMMON_PASSWORDS = new Set([
  'password',
  'password1',
  'password123',
  '123456',
  '123456789',
  '1234567890',
  'qwerty',
  'qwerty123',
  'letmein',
  '111111',
  '000000',
  'abc123',
  'iloveyou',
  'admin',
  'welcome',
  'welcome1',
  'monkey',
  'dragon',
  'football',
  'baseball',
  '123123',
  'sunshine',
  'master',
  'shadow',
  'superman',
  'trustno1',
  'princess',
  'passw0rd',
  'freedom',
  'whatever',
  'starwars',
]);

function hasUpper(password) {
  return /[A-Z]/.test(password);
}
function hasLower(password) {
  return /[a-z]/.test(password);
}
function hasNumber(password) {
  return /[0-9]/.test(password);
}
function hasSymbol(password) {
  return /[^A-Za-z0-9]/.test(password);
}

// Substrings shorter than this are ignored to avoid flagging unrelated
// passwords just because they happen to contain a two-letter fragment of
// someone's name.
const MIN_SUBSTRING_LENGTH = 3;

function containsPersonalInfo(password, { email, name }) {
  const lowerPassword = password.toLowerCase();
  const candidates = [];

  if (email) {
    candidates.push(String(email).split('@')[0]);
  }
  if (name) {
    candidates.push(...String(name).split(/\s+/));
  }

  return candidates
    .map((c) => c.toLowerCase())
    .filter((c) => c.length >= MIN_SUBSTRING_LENGTH)
    .some((c) => lowerPassword.includes(c));
}

async function isReusedPassword(password, passwordHistory = []) {
  const recentHashes = passwordHistory.slice(0, HISTORY_LIMIT);
  for (const hash of recentHashes) {
    // eslint-disable-next-line no-await-in-loop
    if (await bcrypt.compare(password, hash)) {
      return true;
    }
  }
  return false;
}

/**
 * Validates a candidate password against the registration policy.
 * @returns {Promise<{ valid: boolean, errors: string[] }>}
 */
async function validatePasswordPolicy({ password, email, name, passwordHistory = [] }) {
  const errors = [];

  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    errors.push(`Password must be at least ${MIN_LENGTH} characters long`);
  }
  if (typeof password === 'string') {
    if (!hasUpper(password)) errors.push('Password must contain an uppercase letter');
    if (!hasLower(password)) errors.push('Password must contain a lowercase letter');
    if (!hasNumber(password)) errors.push('Password must contain a number');
    if (!hasSymbol(password)) errors.push('Password must contain a symbol');

    if (containsPersonalInfo(password, { email, name })) {
      errors.push('Password must not contain your name or email');
    }
    if (COMMON_PASSWORDS.has(password.toLowerCase())) {
      errors.push('Password is too common');
    }
    if (await isReusedPassword(password, passwordHistory)) {
      errors.push('Password has been used recently — choose a different one');
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Server-side strength estimate (zxcvbn) for live feedback in the client.
 * `userInputs` lets zxcvbn penalize passwords built from the user's own
 * name/email rather than scoring them as if they were random.
 */
function getPasswordStrength(password, userInputs = []) {
  const result = zxcvbn(password || '', userInputs.filter(Boolean));
  return {
    score: result.score, // 0 (weak) – 4 (strong)
    warning: result.feedback.warning,
    suggestions: result.feedback.suggestions,
  };
}

async function hashPassword(password) {
  return bcrypt.hash(password, BCRYPT_COST_FACTOR);
}

function pushPasswordHistory(passwordHistory = [], newHash) {
  return [newHash, ...passwordHistory].slice(0, HISTORY_LIMIT);
}

module.exports = {
  MIN_LENGTH,
  BCRYPT_COST_FACTOR,
  HISTORY_LIMIT,
  validatePasswordPolicy,
  getPasswordStrength,
  hashPassword,
  pushPasswordHistory,
};
