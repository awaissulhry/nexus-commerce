import { defineConfig } from 'vitest/config'

// Pure tests (`*.vitest.test.ts`) and real-PostgreSQL tests (`*.pg.vitest.test.ts`) run together. The PostgreSQL ones
// use throwaway `factory_test_dbkit_*` databases and random roles on the local factory stack (src/testing/), never a
// URL from a `.env`; without the stack they fail, they never skip.
export default defineConfig({
  test: {
    include: ['src/**/*.vitest.test.ts'],
    exclude: ['node_modules/**'],
    environment: 'node',
  },
})
