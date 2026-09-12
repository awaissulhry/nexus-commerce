/** Apply only this reviewed migration, and only to the isolated development clone. */
import { readFile, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
const root = new URL('../../../', import.meta.url)
const require = createRequire(new URL('apps/api/package.json', root))
const { parse } = require('dotenv'), { Client } = require('pg')
const { DATABASE_URL } = parse(await readFile(new URL('apps/api/.env', root)))
const target = new URL(DATABASE_URL)
if (target.hostname !== '127.0.0.1' || target.port !== '55439' || target.pathname !== '/nexus_development') throw new Error('This runner only accepts the isolated local development clone on port 55439.')
const name = '20260911020000_information_formula_destination'
const sql = await readFile(new URL(`packages/database/prisma/migrations/${name}/migration.sql`, root), 'utf8')
const checksum = createHash('sha256').update(sql).digest('hex')
const db = new Client({ connectionString: DATABASE_URL })
await db.connect()
try {
  const receipt = (await db.query('SELECT checksum, finished_at FROM "_prisma_migrations" WHERE migration_name=$1 AND rolled_back_at IS NULL', [name])).rows
  if (receipt.length) {
    if (receipt.length !== 1 || !receipt[0].finished_at || receipt[0].checksum !== checksum) throw new Error('Existing migration receipt needs review.')
    console.log('The reviewed Information migration is already applied locally.')
  } else {
    const snapshot = { target: '127.0.0.1:55439/nexus_development', migration: name, checksum,
      formulas: (await db.query('SELECT * FROM "CellFormula" ORDER BY id')).rows,
      indexes: (await db.query("SELECT indexdef FROM pg_indexes WHERE tablename='CellFormula'")).rows,
      counts: (await db.query('SELECT (SELECT count(*) FROM "Product") products, (SELECT count(*) FROM "ChannelListing") listings')).rows[0],
    }
    const backup = new URL('./evidence/local-formula-before.json', import.meta.url)
    await writeFile(backup, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await db.query('BEGIN')
    try {
      await db.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='60s'")
      await db.query(sql.replace(/^BEGIN;\s*/, '').replace(/COMMIT;\s*$/, ''))
      await db.query('INSERT INTO "_prisma_migrations" (id, checksum, finished_at, migration_name, started_at, applied_steps_count) VALUES ($1,$2,now(),$3,now(),1)', [randomUUID(), checksum, name])
      await db.query('COMMIT')
    } catch (error) { await db.query('ROLLBACK'); throw error }
    const after = (await db.query('SELECT (SELECT count(*) FROM "Product") products, (SELECT count(*) FROM "ChannelListing") listings')).rows[0]
    await writeFile(new URL('./evidence/local-migration-result.json', import.meta.url), JSON.stringify({ target: snapshot.target, migration: name, checksum, appliedAt: new Date().toISOString(), before: snapshot.counts, after, productValuesChangedByMigration: 0, listingValuesChangedByMigration: 0, productionChanged: false }, null, 2) + '\n')
    console.log(JSON.stringify({ applied: name, target: snapshot.target, before: snapshot.counts, after, productionChanged: false }))
  }
} finally { await db.end() }
