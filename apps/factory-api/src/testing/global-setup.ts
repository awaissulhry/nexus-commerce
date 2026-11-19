import { assertTestDatabaseUrl, readWorktree, worktreeDatabaseNames } from '@nexus/factory-db/test-database'
import { readFactoryVariables } from '../env'

/**
 * Vitest global setup: the test-database guard runs once, before any test file is loaded. The run stops unless
 * FACTORY_DATABASE_URL (apps/factory-api/.env, or the process environment) is a loopback database named factory_test…
 * or this worktree's factory_<branch>. It applies even to tests that never connect, so a wrong `.env` is found early.
 */
export default async function setup(): Promise<void> {
  const url = readFactoryVariables().FACTORY_DATABASE_URL
  const database = assertTestDatabaseUrl(url, worktreeDatabaseNames(readWorktree(process.cwd())))
  console.log(`[factory-api tests] database guard: ${database} on loopback`)
  // End check (11-19): a PostgreSQL run (FACTORY_PG_TEST_RUN: run-pg-tests.mjs and the GitHub pg jobs set it) has the test
  // template ready before the first file's set-up starts, so no beforeAll pays for building it. A unit run connects nowhere.
  if (process.env.FACTORY_PG_TEST_RUN) {
    const { prepareTemplate } = await import('@nexus/factory-db/testing')
    const ready = await prepareTemplate()
    if (ready) console.log(`[factory-api tests] test template ${ready.template}: ${ready.built ? 'built' : 'ready'}`)
  }
}
