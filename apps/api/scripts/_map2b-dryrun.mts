/** Applies MAP.2b in a rolled-back transaction and proves ON CONFLICT matches. */
await import('../src/env.js')
const fs = await import('node:fs'); const { default: pg } = await import('pg')
const c = new pg.Client({ connectionString: (process.env.DATABASE_URL ?? '').replace('-pooler','') })
await c.connect(); await c.query('BEGIN')
try {
  await c.query(fs.readFileSync('/Users/awais/nexus-commerce/packages/database/prisma/migrations/20260819b_map2b_account_unique_keys/migration.sql','utf8'))
  console.log('OK migration applied inside the transaction\n')
  for (const r of (await c.query(`SELECT indexname::text n, indexdef::text d FROM pg_indexes
      WHERE tablename IN ('ChannelListing','VariantChannelListing','SyncChannelPolicy')
        AND indexdef LIKE '%UNIQUE%' ORDER BY 1`)).rows)
    console.log(`  ${r.n}\n      ${r.d}`)
  console.log('\nname lengths (Postgres truncates silently >63):')
  for (const r of (await c.query(`SELECT indexname::text n, length(indexname) l FROM pg_indexes
      WHERE indexname LIKE '%_conn_key' ORDER BY 1`)).rows)
    console.log(`  ${String(r.l).padStart(2)}  ${r.n}  ${r.l<=63?'ok':'TRUNCATED'}`)
  console.log('\nON CONFLICT parity — does the new index satisfy the 4-column spec?')
  const probe = (await c.query(`SELECT "productId","channel","marketplace","channelConnectionId" FROM "ChannelListing" LIMIT 1`)).rows[0]
  await c.query(`INSERT INTO "ChannelListing" ("id","productId","channelMarket","channel","region","marketplace","channelConnectionId","updatedAt")
                 VALUES ('probe_never','${probe.productId}','PROBE','${probe.channel}','XX','${probe.marketplace}','${probe.channelConnectionId}', now())
                 ON CONFLICT ("productId","channel","marketplace","channelConnectionId") DO NOTHING`)
  console.log('  ON CONFLICT (productId, channel, marketplace, channelConnectionId) -> ACCEPTED ✓')
  try {
    await c.query(`INSERT INTO "ChannelListing" ("id","productId","channelMarket","channel","region","marketplace","updatedAt")
                   VALUES ('probe_never2','${probe.productId}','PROBE2','${probe.channel}','XX','${probe.marketplace}', now())
                   ON CONFLICT ("productId","channel","marketplace") DO NOTHING`)
    console.log('  ON CONFLICT (3 columns) -> still accepted (unexpected)')
  } catch (e: any) { console.log(`  ON CONFLICT (old 3 columns) -> ${e.code} ${String(e.message).slice(0,60)}  (expected: the old spec is gone)`) }
} catch (e: any) { console.log('FAILED:', e.message, '\n  detail:', e.detail ?? '(none)') }
finally { await c.query('ROLLBACK'); console.log('\nROLLED BACK — nothing committed.'); await c.end() }
