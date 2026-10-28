#!/usr/bin/env node
/**
 * check-policy-parity — RULE: the row-level-security policies, grants and roles the factory database gets are exactly
 * what the generator writes from packages/factory-db/ownership/*.json and the Prisma schema, and they come last.
 *
 *   1. There is a policy migration (a migration.sql that starts with the generator's header).
 *   2. The newest policy migration is the newest migration of all: a schema migration after it would leave its tables
 *      or columns without policies and grants.
 *   3. Its SQL equals the generator's output byte for byte (so no hand edit, and no classification change without a
 *      new run of `npm run policies -w @nexus/factory-db -- <folder>`).
 *
 * The generator and these rules live in packages/factory-db/src/policies.ts. That the SQL also works is proven by
 * check-migrations-replay.mjs and the isolation tests.
 *
 * Run: node scripts/factory/check-policy-parity.mjs — exit 1 on any problem, one per line.
 */
import { tsImport } from 'tsx/esm/api'

const tools = await tsImport('../../packages/factory-db/src/tools.ts', import.meta.url)
const policies = await tsImport('../../packages/factory-db/src/policies.ts', import.meta.url)

let problems
try {
  problems = tools.policyParityProblems()
} catch (error) {
  // The classification itself is broken; check-ownership names the problems.
  problems = [`the generator cannot run: ${error.message.split('\n')[0]} (see check-ownership)`]
}

if (problems.length > 0) {
  console.error(`check-policy-parity: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`)
  process.exit(1)
}
const newest = policies.readMigrations(tools.MIGRATIONS_DIR).filter(policies.isPolicyMigration).at(-1)
console.log(`check-policy-parity: ok (${newest.folder} is the newest migration and equals the generator's output)`)
