/**
 * ACR Stage 5 — did the SAME wipe hit Sponsored Display? READ-ONLY.
 *
 * `archiveMissingTargets` is shared: `syncTargetsForAdGroups` feeds it from `/sp/targets/list`
 * with scope {kind: PRODUCT|AUTO|CATEGORY}. SD's ~360 targets are invisible to that endpoint for
 * exactly the same reason SB's keywords were, so they were exposed to the identical corruption.
 * Only SB keywords were reconciled; this checks whether SD needs the same.
 *
 * Usage: cd apps/api && railway run npx tsx scripts/_acr5-sd-verify.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const { verifyLaunch } = await import('../src/services/advertising/ads-launch-verify.service.js')

console.log('\n— LOCAL SD target rows by status (all ARCHIVED would be the fingerprint) —')
const local = await prisma.$queryRawUnsafe<any[]>(`
  SELECT t.kind, t.status, COUNT(*)::int AS n
  FROM "AdTarget" t JOIN "AdGroup" g ON g.id=t."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c."adProduct"='SPONSORED_DISPLAY' AND t."isNegative"=false
  GROUP BY 1,2 ORDER BY n DESC`)
for (const r of local) console.log(`  kind=${r.kind} status=${r.status} → ${r.n}`)

console.log('\n— LOCAL SD product ads by status —')
const ads = await prisma.$queryRawUnsafe<any[]>(`
  SELECT a.status, COUNT(*)::int AS n
  FROM "AdProductAd" a JOIN "AdGroup" g ON g.id=a."adGroupId" JOIN "Campaign" c ON c.id=g."campaignId"
  WHERE c."adProduct"='SPONSORED_DISPLAY' GROUP BY 1 ORDER BY n DESC`)
for (const r of ads) console.log(`  status=${r.status} → ${r.n}`)

const sd = await prisma.campaign.findMany({
  where: { adProduct: 'SPONSORED_DISPLAY' }, select: { id: true, name: true, marketplace: true },
})
console.log(`\nVerifying ${sd.length} SD campaigns against Amazon…`)
const v = await verifyLaunch(sd.map(c => c.id), 'RECONCILE')
console.log(`\nok=${v.ok}  total=${v.total}  verified=${v.verified}  mismatch=${v.mismatch}  missingOnAmazon=${v.missingOnAmazon}  notPushed=${v.notPushed}  uncovered=${v.uncovered}`)

const byKind = new Map<string, Record<string, number>>()
for (const e of v.entities) {
  const k = byKind.get(e.entityType) ?? {}
  k[e.verdict] = (k[e.verdict] ?? 0) + 1
  byKind.set(e.entityType, k)
}
console.log('\nBY KIND:')
for (const [kind, verdicts] of byKind) console.log(`  ${kind.padEnd(12)} ${JSON.stringify(verdicts)}`)

if (v.problems.length) {
  console.log(`\nPROBLEMS (${v.problems.length}, showing 10):`)
  for (const p of v.problems.slice(0, 10)) console.log(`  ${p}`)
}
console.log(`\nSAFETY — invented failures: ${v.missingOnAmazon === 0 ? 'none (PASS)' : `${v.missingOnAmazon} MISSING_ON_AMAZON — investigate`}`)
await prisma.$disconnect(); process.exit(0)
