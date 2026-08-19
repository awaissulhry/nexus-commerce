/** READ-ONLY. What MAP.2b needs to know before touching a unique key. */
await import('../src/env.js')
const { default: pg } = await import('pg')
const c = new pg.Client({ connectionString: (process.env.DATABASE_URL ?? '').replace('-pooler','') })
await c.connect()
const q = async (s:string)=> (await c.query(s)).rows
console.log('postgres:', (await q('SHOW server_version'))[0].server_version)
console.log('  NULLS NOT DISTINCT needs >= 15\n')

for (const t of ['ChannelListing','VariantChannelListing','SyncChannelPolicy']) {
  const [r] = await q(`SELECT count(*)::int total, count("channelConnectionId")::int attributed FROM "${t}"`)
  console.log(`  ${t.padEnd(24)} total=${String(r.total).padStart(4)} attributed=${String(r.attributed).padStart(4)}  nulls=${r.total-r.attributed}`)
}
console.log('\nChannelListing rows by channel (would NOT NULL block any future channel?)')
for (const r of await q(`SELECT channel, count(*)::int n, count("channelConnectionId")::int a FROM "ChannelListing" GROUP BY 1 ORDER BY 2 DESC`))
  console.log(`  ${String(r.channel).padEnd(10)} ${r.n} rows, ${r.a} attributed`)
console.log('\nChannels with listings but NO active connection (these would break under NOT NULL):')
const orphan = await q(`SELECT DISTINCT cl.channel FROM "ChannelListing" cl
  WHERE NOT EXISTS (SELECT 1 FROM "ChannelConnection" c WHERE c."channelType"=cl.channel AND c."isActive")`)
console.log(orphan.length ? orphan.map(r=>'  '+r.channel).join('\n') : '  (none)')
await c.end()
