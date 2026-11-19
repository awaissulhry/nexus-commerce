import { defineConfig } from 'vitest/config'

// Pure tests only so far. Tests that open a database (isolation, races) come with the tenancy core and run through
// the throwaway-database runner, behind the guard in src/test-database.ts.
// fx-10 (end check): a PostgreSQL run (FACTORY_PG_TEST_RUN — run-pg-tests.mjs and GitHub's pg-db job set it) gives each test
// and hook 30 s, as factory-api's config does: on GitHub's shared runners a PG test of 1-2 s on the Mac passed vitest's
// default 5 s now and then (run 3: portal-requests-th W01). A hang still fails, at 30 s. A unit run keeps vitest's defaults;
// a test or hook with its own timeout keeps it.
const PG_RUN_TIMEOUTS = process.env.FACTORY_PG_TEST_RUN ? { testTimeout: 30_000, hookTimeout: 30_000 } : {}

export default defineConfig({
  test: {
    include: ['src/**/*.vitest.test.ts'],
    exclude: ['node_modules/**', 'src/generated/**'],
    environment: 'node',
    // fx-7 (end check): a PostgreSQL run has the migrated test template ready before the first file's set-up
    // (src/testing/global-setup.ts); a unit run connects nowhere.
    globalSetup: ['./src/testing/global-setup.ts'],
    ...PG_RUN_TIMEOUTS,
  },
})
