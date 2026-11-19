import { defineConfig } from 'vitest/config'

// Pure tests only so far. Tests that open a database (isolation, races) come with the tenancy core and run through
// the throwaway-database runner, behind the guard in src/test-database.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.vitest.test.ts'],
    exclude: ['node_modules/**', 'src/generated/**'],
    environment: 'node',
    // fx-7 (end check): a PostgreSQL run has the migrated test template ready before the first file's set-up
    // (src/testing/global-setup.ts); a unit run connects nowhere.
    globalSetup: ['./src/testing/global-setup.ts'],
  },
})
