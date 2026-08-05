/**
 * AX-IE.1 — READ ONLY. Why does the Amazon shadow lose metric rows?
 *
 * Source key: (profileId, adProduct, entityType, entityId, date)   — 5 parts
 * Dest key:   (channel, entityType, entityId, date)                — 4 parts
 *
 * The destination cannot represent two source rows that share
 * (entityType, entityId, date) but differ in profileId or adProduct, so
 * createMany({ skipDuplicates: true }) silently drops the loser.
 */
const { default: p } = await import('../src/db.js')
const q = async (l: string, sql: string) => {
  const r = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(sql)
  console.log(l, JSON.stringify(r, (_k, v) => (typeof v === 'bigint' ? String(v) : v)))
}
await q('SOURCE_ROWS', `SELECT count(*)::bigint n FROM "AmazonAdsDailyPerformance"`)
await q('DISTINCT_UNDER_DEST_KEY', `SELECT count(*)::bigint n FROM (
  SELECT DISTINCT "entityType","entityId",date FROM "AmazonAdsDailyPerformance") x`)
await q('COLLIDING', `SELECT count(*)::bigint groups, COALESCE(sum(c-1),0)::bigint rows_lost FROM (
  SELECT "entityType","entityId",date, count(*) c FROM "AmazonAdsDailyPerformance"
  GROUP BY 1,2,3 HAVING count(*) > 1) x`)
await q('COLLISION_SPANS', `SELECT
    count(*) FILTER (WHERE profiles > 1)::bigint groups_spanning_profiles,
    count(*) FILTER (WHERE adproducts > 1)::bigint groups_spanning_adproducts
  FROM (SELECT count(DISTINCT "profileId") profiles, count(DISTINCT "adProduct") adproducts
        FROM "AmazonAdsDailyPerformance" GROUP BY "entityType","entityId",date
        HAVING count(*) > 1) x`)
await q('SAMPLE', `SELECT "entityType" et,"entityId" eid,date::text d,"profileId" pid,"adProduct" ap,marketplace mk,"costMicros"::text cost
  FROM "AmazonAdsDailyPerformance" WHERE ("entityType","entityId",date) IN (
    SELECT "entityType","entityId",date FROM "AmazonAdsDailyPerformance"
    GROUP BY 1,2,3 HAVING count(*) > 1) ORDER BY "entityId", date LIMIT 4`)
await p.$disconnect()
