import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/server/__tests__/**/*.test.ts'],
    pool: 'forks',
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});
