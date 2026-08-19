/** Applies MAP.2a inside a transaction and ALWAYS rolls back. Proves the SQL parses,
 *  the backfill attributes every row, and the §4 gate passes — without committing. */
await import('../src/env.js')
const fs = await import('node:fs')
const { default: pg } = await import('pg')

// reference_neon_migrations: DDL must not go through the pooler.
const url = (process.env.DATABASE_URL ?? '').replace('-pooler', '')
const sql = fs.readFileSync('/Users/awais/nexus-commerce/packages/database/prisma/migrations/20260819a_map2_account_dimension/migration.sql', 'utf8')

const c = new pg.Client({ connectionString: url })
await c.connect()
const count = async (q: string) => (await c.query(q)).rows[0].n

await c.query('BEGIN')
try {
  await c.query(sql)
  console.log('OK migration SQL applied inside the transaction (the section-4 gate did not raise)\n')

  console.log('ATTRIBUTION AFTER BACKFILL')
  for (const t of ['ChannelListing','VariantChannelListing','SharedListingMembership','Order','SyncChannelPolicy']) {
    const total = await count(`SELECT count(*)::int AS n FROM "${t}"`)
    const set   = await count(`SELECT count(*)::int AS n FROM "${t}" WHERE "channelConnectionId" IS NOT NULL`)
    console.log(`  ${t.padEnd(24)} ${String(set).padStart(5)} / ${String(total).padEnd(5)} attributed`)
  }

  console.log('\nUNATTRIBUTED, BY REASON')
  const orphans = await c.query(`SELECT channel::text AS channel, count(*)::int AS n FROM "Order" WHERE "channelConnectionId" IS NULL GROUP BY 1 ORDER BY 2 DESC`)
  if (orphans.rows.length === 0) console.log('  (none)')
  for (const r of orphans.rows) console.log(`  Order.channel=${r.channel}: ${r.n} (no active connection for that channel)`)

  console.log('\nCHANNELCONNECTION AFTER')
  const cc = await c.query(`SELECT "channelType","isPrimary","externalAccountId" FROM "ChannelConnection" WHERE "isActive" ORDER BY "channelType"`)
  for (const r of cc.rows) console.log(`  ${r.channelType.padEnd(8)} primary=${r.isPrimary} extId=${JSON.stringify(r.externalAccountId)}`)

  console.log('\nUNIQUE INDEXES ON ChannelConnection AFTER')
  const ix = await c.query(`SELECT indexname::text AS n, indexdef::text AS d FROM pg_indexes WHERE tablename='ChannelConnection' AND indexdef LIKE '%UNIQUE%' ORDER BY 1`)
  for (const r of ix.rows) console.log(`  ${r.n}\n      ${r.d}`)
} catch (e: any) {
  console.log('FAILED:', e?.message)
  console.log('  detail:', e?.detail ?? '(none)')
} finally {
  await c.query('ROLLBACK')
  console.log('\nROLLED BACK - nothing was committed.')
  await c.end()
}
