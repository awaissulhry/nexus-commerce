import { defineConfig } from 'vitest/config'

// Pure logic: no database, no network, no environment variables.
export default defineConfig({
  test: {
    include: ['src/**/*.vitest.test.ts'],
    exclude: ['node_modules/**'],
    environment: 'node',
  },
})
