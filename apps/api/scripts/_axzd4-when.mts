const { default: p } = await import('../src/db.js')
const r = await p.$queryRawUnsafe<Array<Record<string,unknown>>>(
  `SELECT max("settingsSyncedAt")::text newest, count(*) FILTER (WHERE "settingsSyncedAt" > now() - interval '30 min')::bigint last30m FROM "Campaign"`)
console.log('SETTINGS_SYNC', JSON.stringify(r,(k,v)=>typeof v==='bigint'?String(v):v))
const c = await p.cronRun.findMany({ orderBy:{startedAt:'desc'}, take: 40, select:{jobName:true,startedAt:true} })
const names = [...new Set(c.map(x=>x.jobName))]
console.log('RECENT_CRONS', JSON.stringify(names))
await p.$disconnect()
