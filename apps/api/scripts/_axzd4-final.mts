const { default: p } = await import('../src/db.js')
const r = await p.$queryRawUnsafe<Array<Record<string,unknown>>>(
  `SELECT count(*)::bigint total,
          count(*) FILTER (WHERE "settingsSyncedAt" > '2026-07-28 15:19:00')::bigint synced_in_last_run,
          count(*) FILTER (WHERE "targetingType" IS NOT NULL)::bigint have_targeting
     FROM "Campaign"`)
console.log('CAMPAIGNS', JSON.stringify(r,(k,v)=>typeof v==='bigint'?String(v):v))
console.log('DRIFT_OPEN', await p.adDrift.count({ where: { resolvedAt: null } }), 'TOTAL', await p.adDrift.count())
await p.$disconnect()
