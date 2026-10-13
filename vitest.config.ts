import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

// The desktop app's tests read the runner as the library its sources are, so that they do not need its bundle built first.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: /^@escritoriio\/runner$/, replacement: fileURLToPath(new URL('apps/runner/src/index.ts', import.meta.url)) }],
  },
  test: {
    environment: 'node',
    include: ['packages/**/src/**/*.test.{ts,tsx}', 'apps/**/src/**/*.test.{ts,tsx}'],
    exclude: ['**/node_modules/**'],
  },
});
