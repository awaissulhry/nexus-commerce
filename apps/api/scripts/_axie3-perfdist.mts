const { default: p } = await import('../src/db.js')
const r = await p.$queryRawUnsafe<Array<Record<string,unknown>>>(`
  SELECT "entityType", count(*)::bigint rows,
         count("localEntityId")::bigint with_local,
         count(*) FILTER (WHERE date >= now() - interval '30 days')::bigint last30,
         count("localEntityId") FILTER (WHERE date >= now() - interval '30 days')::bigint last30_local,
         max(date)::text newest
  FROM "AmazonAdsDailyPerformance" GROUP BY 1 ORDER BY 2 DESC`)
console.log(JSON.stringify(r,(_k,v)=>typeof v==='bigint'?String(v):v,1))
await p.$disconnect()
