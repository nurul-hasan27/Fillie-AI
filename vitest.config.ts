import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'unit',
    include: ['tests/unit/**/*.test.ts'],
    environment: 'happy-dom',
    setupFiles: ['tests/unit/setup.ts'],
  },
});
