import { prepareTemplate } from './database'

/**
 * Vitest global setup of factory-db (end check 11-19, fx-7): a PostgreSQL run (FACTORY_PG_TEST_RUN: run-pg-tests.mjs and
 * GitHub's pg-db job set it) has the migrated test template ready before the first file's set-up starts, where no timeout
 * applies — as factory-api's globalSetup does since #1689. Without it the pg-db job's first files built the template inside
 * their beforeAll (~395 migrations in ~120 s on GitHub's runners) and quality-shipping's 90 s hook timed out. A unit run
 * (no FACTORY_PG_TEST_RUN) connects nowhere.
 */
export default async function setup(): Promise<void> {
  if (!process.env.FACTORY_PG_TEST_RUN) return
  const ready = await prepareTemplate()
  if (ready) console.log(`[factory-db tests] test template ${ready.template}: ${ready.built ? 'built' : 'ready'}`)
}
