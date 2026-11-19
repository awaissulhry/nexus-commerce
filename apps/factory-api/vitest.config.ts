import { defineConfig } from 'vitest/config'

// fx-10 (end check): a PostgreSQL run (FACTORY_PG_TEST_RUN — run-pg-tests.mjs, the golden flows and GitHub's pg jobs set it)
// gives each test and hook 30 s. On GitHub's shared runners (16 shards, 2 workers each) a PG test of 1-2 s on the Mac passed
// vitest's default 5 s now and then — a different one each run (runs 3-5: locations-depth SCM-178, styles, jobs, files
// COL-050, locations SCM-176, …), each passing in the run before. A hang still fails, at 30 s. A unit run keeps vitest's
// defaults (5 s, hooks 10 s); a test, describe or file with its own timeout (SLOW_TEST_TIMEOUT_MS, vi.setConfig) keeps it.
const PG_RUN_TIMEOUTS = process.env.FACTORY_PG_TEST_RUN ? { testTimeout: 30_000, hookTimeout: 30_000 } : {}

export default defineConfig({
  test: {
    include: ['src/**/*.vitest.test.ts'],
    exclude: ['node_modules/**', 'dist/**'],
    environment: 'node',
    // The test-database guard (src/testing/global-setup.ts): no test starts on a database that is not a loopback
    // factory_test… or this worktree's factory_<branch>.
    globalSetup: ['./src/testing/global-setup.ts'],
    env: { FACTORY_ENV: 'test' },
    ...PG_RUN_TIMEOUTS,
  },
})
