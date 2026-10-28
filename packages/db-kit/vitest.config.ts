import { defineConfig } from 'vitest/config'

// Pure tests only so far. Tests that open a database arrive with the tenant adapter; they will use the factory's
// throwaway-database runner, never a URL from a `.env`.
export default defineConfig({
  test: {
    include: ['src/**/*.vitest.test.ts'],
    exclude: ['node_modules/**'],
    environment: 'node',
  },
})
