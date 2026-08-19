/** Proves what MAP.2b-ii unlocks: a SECOND account's listing row for a product
 *  that already has one. Runs inside a transaction that is ALWAYS rolled back. */
await import('../src/env.js')
const { default: pg } = await import('pg')
const c = new pg.Client({ connectionString: (process.env.DATABASE_URL ?? '').replace('-pooler','') })
await c.connect()

const idx = (await c.query(`SELECT indexname::text n FROM pg_indexes
  WHERE tablename IN ('ChannelListing','VariantChannelListing','SyncChannelPolicy')
    AND indexdef LIKE '%UNIQUE%' ORDER BY 1`)).rows.map(r => r.n)
console.log('unique indexes now:')
for (const n of idx) console.log('  ' + n)
console.log('\nlegacy 3-column keys still present:',
  idx.filter(n => n.endsWith('_key') && !n.endsWith('_conn_key') && !n.endsWith('_pkey') && n !== 'VariantChannelListing_variantId_channelId_key'))

await c.query('BEGIN')
try {
  const row = (await c.query(`SELECT "productId","channel","marketplace","channelMarket" FROM "ChannelListing" WHERE channel='EBAY' LIMIT 1`)).rows[0]
  // A second, DIFFERENT eBay connection.
  await c.query(`INSERT INTO "ChannelConnection" (id,"channelType","managedBy","isActive","externalAccountId","displayName","createdAt","updatedAt")
                 VALUES ('probe_conn_2','EBAY','oauth',true,'second_seller_probe','Second eBay probe',now(),now())`)
  console.log('\n✓ a SECOND active eBay connection inserted (the MAP.2a identity index allows it once identities differ)')

  await c.query(`INSERT INTO "ChannelListing" (id,"productId","channelMarket",channel,region,marketplace,"channelConnectionId","updatedAt")
                 VALUES ('probe_listing_2','${row.productId}','${row.channelMarket}','${row.channel}','XX','${row.marketplace}','probe_conn_2',now())`)
  console.log('✓ the SAME product now has a listing on BOTH accounts for the same marketplace')
  console.log('   -> this is exactly what the legacy 3-column key used to forbid')

  // And prove the new key still forbids a true duplicate WITHIN one account.
  try {
    await c.query(`INSERT INTO "ChannelListing" (id,"productId","channelMarket",channel,region,marketplace,"channelConnectionId","updatedAt")
                   VALUES ('probe_listing_3','${row.productId}','${row.channelMarket}','${row.channel}','XX','${row.marketplace}','probe_conn_2',now())`)
    console.log('✗ BAD: a duplicate within ONE account was accepted')
  } catch (e: any) {
    console.log(`✓ a duplicate WITHIN one account is still refused (${e.code}) — the constraint narrowed, it did not disappear`)
  }
} catch (e: any) {
  console.log('FAILED:', e.code, e.message)
} finally {
  await c.query('ROLLBACK'); console.log('\nROLLED BACK — nothing committed.'); await c.end()
}
