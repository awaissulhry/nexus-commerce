/** READ-ONLY post-migration verification of MAP.2a on prod. */
await import('../src/env.js')
const { default: pg } = await import('pg')
const c = new pg.Client({ connectionString: (process.env.DATABASE_URL ?? '').replace('-pooler','') })
await c.connect()
const q = async (s: string) => (await c.query(s)).rows

console.log('ATTRIBUTION (must be total, except rows with no active connection for their channel)')
for (const t of ['ChannelListing','VariantChannelListing','SharedListingMembership','Order','SyncChannelPolicy']) {
  const [r] = await q(`SELECT count(*)::int AS total, count("channelConnectionId")::int AS set FROM "${t}"`)
  console.log(`  ${t.padEnd(24)} ${String(r.set).padStart(5)} / ${String(r.total).padEnd(5)}  ${r.set===r.total?'✓ complete':'← check reason'}`)
}

console.log('\nPER-CHANNEL, and does the attributed connection match the row\'s own channel?')
for (const r of await q(`SELECT cl.channel, c."channelType", count(*)::int AS n
  FROM "ChannelListing" cl JOIN "ChannelConnection" c ON c.id = cl."channelConnectionId"
  GROUP BY 1,2 ORDER BY 1`)) console.log(`  ChannelListing ${r.channel} -> ${r.channelType}: ${r.n} ${r.channel===r.channelType?'✓':'✗ MISMATCH'}`)
for (const r of await q(`SELECT o.channel::text AS channel, c."channelType", count(*)::int AS n
  FROM "Order" o JOIN "ChannelConnection" c ON c.id = o."channelConnectionId"
  GROUP BY 1,2 ORDER BY 3 DESC`)) console.log(`  Order ${r.channel} -> ${r.channelType}: ${r.n} ${r.channel===r.channelType?'✓':'✗ MISMATCH'}`)
const [sl] = await q(`SELECT count(*)::int AS n FROM "SharedListingMembership" s JOIN "ChannelConnection" c ON c.id=s."channelConnectionId" WHERE c."channelType"='EBAY'`)
console.log(`  SharedListingMembership -> EBAY: ${sl.n} ✓`)

console.log('\nCHANNELCONNECTION')
for (const r of await q(`SELECT "channelType","isActive","isPrimary","externalAccountId","accountLabel" FROM "ChannelConnection" WHERE "isActive" ORDER BY "channelType"`))
  console.log(`  ${r.channelType.padEnd(8)} primary=${r.isPrimary} extId=${JSON.stringify(r.externalAccountId)} label=${JSON.stringify(r.accountLabel)}`)
const [p] = await q(`SELECT count(*)::int AS n FROM "ChannelConnection" WHERE "isPrimary"`)
console.log(`  rows with isPrimary=true: ${p.n} (expect one per active channel = 2)`)

console.log('\nINDEXES')
for (const r of await q(`SELECT indexname::text AS n FROM pg_indexes WHERE tablename='ChannelConnection' AND indexdef LIKE '%UNIQUE%' ORDER BY 1`)) console.log(`  ${r.n}`)
console.log('  singleton gone:', (await q(`SELECT 1 FROM pg_indexes WHERE indexname='ChannelConnection_channelType_marketplace_active_key'`)).length === 0)

console.log('\nMIGRATION RECORD')
for (const r of await q(`SELECT migration_name::text AS n, finished_at, rolled_back_at, applied_steps_count FROM _prisma_migrations WHERE migration_name='20260819a_map2_account_dimension'`))
  console.log(' ', r)
await c.end()
