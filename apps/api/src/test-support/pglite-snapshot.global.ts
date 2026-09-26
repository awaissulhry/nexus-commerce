/**
 * Vitest global setup (regressions project) — build the `formulaDatabase()` starting point ONCE per
 * run and hand every test file a copy (docs/ci-plan.md §3, "template DB clone").
 *
 * Measured 2026-09-26: building it takes 2.3 s (prisma migrate diff 0.86 s, PGlite start 0.61 s,
 * schema 0.56 s, policies 0.25 s); loading a saved copy takes 0.34 s. 52 test files build one.
 *
 * Isolation is unchanged: every file still gets its OWN database, a copy nobody else touches. Only
 * the build is shared — never the data.
 *
 * The cache key is the exact SQL the database is built from (schema, deployed-only extras, the
 * generated policies) plus the PGlite version, so a schema or policy change always builds a new one.
 * The file lives in the OS temp dir, never in the repo.
 *
 * NEXUS_TEST_NO_TEMPLATE=1 turns this off; each file then builds its own database as before.
 */
import { PGlite } from '@electric-sql/pglite'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyFormulaSchema, formulaSchemaStatements, PGLITE_SNAPSHOT_ENV } from './formula-schema.js'

export default async function setup() {
  if (process.env.NEXUS_TEST_NO_TEMPLATE === '1') return
  const statements = formulaSchemaStatements()
  const pgliteVersion = JSON.parse(readFileSync(fileURLToPath(new URL('../../../../node_modules/@electric-sql/pglite/package.json', import.meta.url)), 'utf8')).version
  const key = createHash('sha256').update(pgliteVersion).update('\0').update(statements.join('\0')).digest('hex').slice(0, 20)
  const path = join(tmpdir(), `nexus-pglite-${key}.tar`)
  if (!existsSync(path)) {
    const db = await PGlite.create()
    await applyFormulaSchema(db, statements)
    const dump = await db.dumpDataDir('none')
    await db.close()
    const partial = `${path}.${process.pid}.partial`
    writeFileSync(partial, Buffer.from(await dump.arrayBuffer()))
    renameSync(partial, path) // atomic: a concurrent run never reads half a file
    // Older snapshots belong to older schemas; keep the temp dir from filling up.
    for (const name of readdirSync(tmpdir())) {
      if (/^nexus-pglite-[0-9a-f]{20}\.tar$/.test(name) && join(tmpdir(), name) !== path) rmSync(join(tmpdir(), name), { force: true })
    }
  }
  process.env[PGLITE_SNAPSHOT_ENV] = path
}
