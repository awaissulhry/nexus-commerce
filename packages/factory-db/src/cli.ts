import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { openFactoryDatabase } from './client'
import type { SeedContext } from './seeding'
import { assertTestDatabaseUrl, readWorktree, worktreeDatabaseNames } from './test-database'
import { migratedDatabase } from './testing/database'
import { MIGRATIONS_DIR, ownershipProblems, PACKAGE_DIR, policyParityProblems, SEED_DIR, writePolicyMigration } from './tools'

/**
 * The package's commands (package.json scripts):
 *   migration <folder>  write the schema migration prisma/migrations/<folder>/migration.sql: the difference between
 *                       the existing migrations (applied to a throwaway database) and prisma/schema, by
 *                       `prisma migrate diff --from-config-datasource`. Same result as --from-migrations, without a
 *                       shadow database setting. Then run `policies`.
 *   policies <folder>   write the policy migration prisma/migrations/<folder>/migration.sql from ownership and schema
 *   check               the static checks: ownership and policy parity
 *   seed                the synthetic seed (seed/*.ts, in name order) into FACTORY_DATABASE_URL, the runtime login's
 *                       URL; only a loopback factory_test… or this worktree's factory_<branch> database
 */

async function seed(): Promise<void> {
  const url = process.env.FACTORY_DATABASE_URL
  assertTestDatabaseUrl(url, worktreeDatabaseNames(readWorktree(PACKAGE_DIR)))
  const db = await openFactoryDatabase({ connectionString: url as string, pool: { max: 4 } })
  try {
    const context: SeedContext = { db, namespace: 'seed' }
    for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
      const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: SeedContext) => Promise<unknown> }
      await module.seed(context)
      console.log(`seed: ${file} done`)
    }
  } finally {
    await db.close()
  }
}

async function migration(folder: string): Promise<void> {
  if (!/^\d{12,14}_[a-z0-9_]+$/.test(folder) || folder.endsWith('_policies')) {
    throw new Error(`Migration folder "${folder}": expected <YYYYMMDDHHmm>_<module>_<name>, e.g. 202610281200__core_tenancy.`)
  }
  const dir = join(MIGRATIONS_DIR, folder)
  if (existsSync(dir)) throw new Error(`${folder} exists already; delete it first to generate it again.`)
  const db = await migratedDatabase('diff')
  try {
    const run = spawnSync(join(PACKAGE_DIR, '..', '..', 'node_modules', '.bin', 'prisma'), ['migrate', 'diff', '--from-config-datasource', '--to-schema', 'prisma/schema', '--script'], {
      cwd: PACKAGE_DIR,
      encoding: 'utf8',
      env: { ...process.env, FACTORY_MIGRATION_DATABASE_URL: db.url('postgres'), CHECKPOINT_DISABLE: '1', PRISMA_HIDE_UPDATE_MESSAGE: '1' },
    })
    if (run.status !== 0) throw new Error(`prisma migrate diff failed:\n${run.stdout}${run.stderr}`)
    if (!/^\s*(ALTER|CREATE|DROP|COMMENT)\b/im.test(run.stdout)) {
      console.log('migration: the schema matches the migrations; nothing to write')
      return
    }
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'migration.sql'), run.stdout)
    console.log(`migration: wrote ${join(dir, 'migration.sql')}; now run \`npm run policies -w @nexus/factory-db -- <folder>\``)
  } finally {
    await db.close()
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...args] = argv
  if (command === 'migration') {
    if (args.length !== 1) throw new Error('Usage: npm run migration -w @nexus/factory-db -- <YYYYMMDDHHmm>_<module>_<name>')
    await migration(args[0] as string)
    return 0
  }
  if (command === 'policies') {
    if (args.length !== 1) throw new Error('Usage: npm run policies -w @nexus/factory-db -- <YYYYMMDDHHmm>_<module>_policies')
    console.log(`policies: wrote ${writePolicyMigration(args[0] as string)}`)
    return 0
  }
  if (command === 'check') {
    const problems = [...ownershipProblems(), ...policyParityProblems()]
    for (const problem of problems) console.error(problem)
    console.log(problems.length === 0 ? 'check: ownership and policy parity ok' : `check: ${problems.length} problem(s)`)
    return problems.length === 0 ? 0 : 1
  }
  if (command === 'seed') {
    await seed()
    return 0
  }
  throw new Error(`Unknown command ${JSON.stringify(command)}: use migration <folder>, policies <folder>, check or seed.`)
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: Error) => {
    console.error(error.message)
    process.exit(1)
  },
)
