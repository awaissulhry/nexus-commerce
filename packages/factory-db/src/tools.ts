import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkOwnership, policyInputs, readOwnershipFolder } from './ownership'
import { checkPolicyParity, isPolicyMigration, policyMigrationSql, readMigrations } from './policies'
import { readSchemaFolder } from './schema-models'

/**
 * The package's own files and the checks over them, for the CLI (src/cli.ts), the guards in scripts/factory/ and the
 * tests. Reads files only; no database, no environment.
 */

export const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url))
export const SCHEMA_DIR = join(PACKAGE_DIR, 'prisma', 'schema')
export const MIGRATIONS_DIR = join(PACKAGE_DIR, 'prisma', 'migrations')
export const OWNERSHIP_DIR = join(PACKAGE_DIR, 'ownership')
export const SEED_DIR = join(PACKAGE_DIR, 'seed')

export const loadSchema = () => readSchemaFolder(SCHEMA_DIR)
export const loadOwnership = () => readOwnershipFolder(OWNERSHIP_DIR)

/** check-ownership: every model classified, every classification consistent. */
export const ownershipProblems = (): string[] => checkOwnership(loadSchema(), loadOwnership())

/** The policy migration the generator writes for the current schema and ownership. */
export const generatedPolicySql = (): string => policyMigrationSql(policyInputs(loadSchema(), loadOwnership()))

/** check-policy-parity: the newest policy migration is the last migration and equals the generator's output. */
export const policyParityProblems = (): string[] => checkPolicyParity(readMigrations(MIGRATIONS_DIR), generatedPolicySql())

const FOLDER = /^\d{12,14}_[a-z0-9_]*_policies$/

/** Writes (or rewrites) the policy migration `prisma/migrations/<folder>/migration.sql`. Returns its path. */
export function writePolicyMigration(folder: string): string {
  if (!FOLDER.test(folder)) {
    throw new Error(`Policy migration folder "${folder}": expected <YYYYMMDDHHmm>_<module>_policies, e.g. 202610281201__core_policies.`)
  }
  const dir = join(MIGRATIONS_DIR, folder)
  const file = join(dir, 'migration.sql')
  const existing = readMigrations(MIGRATIONS_DIR).find((migration) => migration.folder === folder)
  if (existing && !isPolicyMigration(existing)) throw new Error(`${folder} is a schema migration; refusing to overwrite it.`)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(file, generatedPolicySql())
  return file
}
