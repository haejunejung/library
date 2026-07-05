import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import perfectionist from 'eslint-plugin-perfectionist';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  perfectionist.configs['recommended-natural'],
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always'],
      'no-console': 'warn',
      'no-var': 'error',
      'object-shorthand': ['error', 'always'],
      'prefer-const': 'error',
    },
  },
  {
    files: ['**/*.{test,spec}.{ts,tsx}'],
    rules: {
      'no-console': 'off',
    },
  },
  prettier,
);
