import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'node_modules/', 'old-tron/', 'public/', 'sprites-source/', 'scripts/bench/wasm/*.as.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Unused parameters are fine when prefixed with an underscore
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Node scripts
    files: ['tests/e2e/**', 'tools/**', 'scripts/**', '*.config.*'],
    languageOptions: { globals: { process: 'readonly', console: 'readonly', fetch: 'readonly', Response: 'readonly', URL: 'readonly', window: 'readonly', document: 'readonly', localStorage: 'readonly', setTimeout: 'readonly', performance: 'readonly', requestAnimationFrame: 'readonly' } },
  },
);
