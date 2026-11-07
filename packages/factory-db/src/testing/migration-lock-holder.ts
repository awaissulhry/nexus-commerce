import { withMigrationLock, type MigrationLockOptions } from './migration-lock'

/**
 * A holder of the test migration lock in a process of its own, for migration-lock.pg.vitest.test.ts (never imported):
 * it prints WAITING, takes the lock with withMigrationLock, prints HELD and holds it until the test stops (SIGSTOP) or
 * kills it. Its options come as JSON in FACTORY_TEST_LOCK_HOLDER. Run: node --import tsx migration-lock-holder.ts
 */
const options = JSON.parse(process.env.FACTORY_TEST_LOCK_HOLDER ?? 'null') as MigrationLockOptions | null
if (!options) throw new Error('FACTORY_TEST_LOCK_HOLDER is not set.')
console.log('WAITING')
await withMigrationLock(options, async () => {
  console.log('HELD')
  await new Promise<never>(() => {})
})
