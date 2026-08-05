const { default: p } = await import('../src/db.js')
const r = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(
  `SELECT status::text, count(*)::bigint n FROM "Campaign" WHERE "targetingType" IS NULL GROUP BY 1 ORDER BY 2 DESC`)
console.log('NULL_BY_STATUS', JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))
await p.$disconnect()
