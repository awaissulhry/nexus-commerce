import { assertTestDatabaseUrl, readWorktree, worktreeDatabaseNames } from '@nexus/factory-db/test-database'
import { readFactoryVariables } from '../env'

/**
 * Vitest global setup: the test-database guard runs once, before any test file is loaded. The run stops unless
 * FACTORY_DATABASE_URL (apps/factory-api/.env, or the process environment) is a loopback database named factory_test…
 * or this worktree's factory_<branch>. It applies even to tests that never connect, so a wrong `.env` is found early.
 */
export default function setup(): void {
  const url = readFactoryVariables().FACTORY_DATABASE_URL
  const database = assertTestDatabaseUrl(url, worktreeDatabaseNames(readWorktree(process.cwd())))
  console.log(`[factory-api tests] database guard: ${database} on loopback`)
}
