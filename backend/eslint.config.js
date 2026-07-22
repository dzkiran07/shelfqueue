const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // caughtErrors: 'none' — this codebase consistently writes
      // `catch (err) { ... }` and sometimes deliberately ignores the
      // specific error in favor of a generic fallback response; renaming
      // every such binding to `_err` would be pure churn.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    },
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
  },
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
];
