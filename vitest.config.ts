import { defineConfig } from 'vitest/config';

// API tests must read server modules without inheriting the web server's file restrictions.
export default defineConfig({
  test: { environment: 'node', include: ['src/**/*.test.ts', 'server/**/*.test.ts'] },
});
