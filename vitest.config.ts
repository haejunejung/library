import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      include: ['packages/**/src/**'],
      provider: 'v8',
    },
    globals: true,
    projects: [
      {
        test: {
          environment: 'node',
          exclude: ['packages/react-hooks/**'],
          globals: true,
          include: ['packages/**/*.{test,spec}.ts'],
          name: 'node',
        },
      },
      {
        test: {
          environment: 'jsdom',
          globals: true,
          include: ['**/*.{test,spec}.{ts,tsx}'],
          name: 'react-hooks',
          root: './packages/react-hooks',
        },
      },
    ],
  },
});
