---
paths:
  - "**/*.vitest.test.ts"
  - "**/__tests__/**"
  - "**/*.test.ts"
  - "**/*.spec.ts"
---

# Tests

- Name new tests `*.vitest.test.ts`; vitest collects nothing else (except `apps/api/src/**/__tests__/*.test.ts`).
  A plain `*.test.ts` in apps/api is a legacy `npx tsx` runner and never runs in the suite.
- Run API tests from `apps/api` (`npx vitest run <file>`). From the repo root, the production `.env` wins.
- apps/web tests run in Node with no jsdom. Test logic there; test browser behaviour with Playwright
  (`apps/web/tests/*.spec.ts`).
- `formulaDatabase()` is PGlite with one connection, so a race test passes there whether or not the code is safe.
  Use `concurrentDatabase()`, or add the suite to `SUITES` in `scripts/run-real-postgres-tests.mjs`.
- The API suite runs with business profiles OFF. A test that needs them sets
  `process.env.NEXUS_WORKSPACES_ENABLED = '1'` and restores the old value afterwards.
- A test that writes to the shared local dev database must remove what it wrote. Prefer `formulaDatabase()`.
