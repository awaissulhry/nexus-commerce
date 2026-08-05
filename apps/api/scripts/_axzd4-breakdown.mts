const { default: p } = await import('../src/db.js')
const byField = await p.$queryRawUnsafe<Array<Record<string,unknown>>>(
  `SELECT field, classification, count(*)::bigint n FROM "AdDrift" WHERE "resolvedAt" IS NULL GROUP BY 1,2 ORDER BY 3 DESC`)
console.log('BY_FIELD', JSON.stringify(byField,(k,v)=>typeof v==='bigint'?String(v):v))
const samples = await p.$queryRawUnsafe<Array<Record<string,unknown>>>(
  `SELECT "entityName", marketplace, field, "ourValue", "amazonValue", classification
   FROM "AdDrift" WHERE "resolvedAt" IS NULL AND classification='EXTERNAL_CHANGE' LIMIT 6`)
console.log('EXTERNAL', JSON.stringify(samples, null, 1))
await p.$disconnect()
