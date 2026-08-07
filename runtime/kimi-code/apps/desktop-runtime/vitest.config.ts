import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'desktop-runtime',
    include: ['test/**/*.test.ts'],
  },
});
