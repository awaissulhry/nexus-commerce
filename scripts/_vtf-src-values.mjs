import { open } from './_vtf-db.mjs'
const c = await open()
console.log(JSON.stringify((await c.query(`SELECT "variationSource", count(*)::int n FROM "ReadinessIndex" WHERE "variationSource" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC`)).rows))
console.log('first 3 of the LIMIT 50 scan:', JSON.stringify((await c.query(`SELECT DISTINCT "productId","variationSource" FROM "ReadinessIndex" WHERE "variationSource" IS NOT NULL LIMIT 3`)).rows))
await c.end()
