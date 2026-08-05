/** AX-ZD.1 — is orphan marking firing, and does write-generation respect it? */
import prisma from '../src/db.js'

console.log('AdTarget orphaned :', await prisma.adTarget.count({ where: { orphanedAt: { not: null } } }))
console.log('AdTarget total    :', await prisma.adTarget.count())

// The 19 entities behind the last 7 days of dead writes — are they marked?
const ids = await prisma.$queryRawUnsafe<Array<{ entityid: string }>>(`
  SELECT DISTINCT "payload"->>'entityId' AS entityid
  FROM "OutboundSyncQueue"
  WHERE "syncType" LIKE 'AD_%' AND "isDead" = true
    AND "createdAt" >= now() - interval '7 days'`)
const list = ids.map((r) => r.entityid).filter(Boolean)
const marked = await prisma.adTarget.count({
  where: { id: { in: list }, orphanedAt: { not: null } },
})
const exist = await prisma.adTarget.count({ where: { id: { in: list } } })
console.log(`entities behind dead writes: ${list.length} | exist as AdTarget: ${exist} | marked orphaned: ${marked}`)

// Are new writes still being generated for already-orphaned entities?
const recentForOrphans = await prisma.$queryRawUnsafe<Array<{ n: number }>>(`
  SELECT COUNT(*)::int AS n FROM "OutboundSyncQueue" q
  JOIN "AdTarget" t ON t."id" = q."payload"->>'entityId'
  WHERE q."syncType" LIKE 'AD_%'
    AND t."orphanedAt" IS NOT NULL
    AND q."createdAt" > t."orphanedAt"`)
console.log('writes enqueued AFTER the entity was marked orphaned:', recentForOrphans[0]!.n)
await prisma.$disconnect()
