/** HV.6 — reach, the account dial, and the one-row bucketing boundary. READ-ONLY. */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const int = (n: any) => Number(n).toLocaleString('en-IE')

console.log('\n═══ A · rule scope census (all 62 rules) ═══')
const rules: any[] = await prisma.automationRule.findMany()
const scoped = rules.filter((r) => r.scopeCampaignId || r.scopePortfolioId || r.scopeMarketplace || r.scopeProductId)
console.log(`  carrying ANY scope: ${scoped.length} of ${rules.length}`)
const g = { campaign: 0, portfolio: 0, marketplace: 0, product: 0 }
for (const r of scoped) { if (r.scopeCampaignId) g.campaign++; if (r.scopePortfolioId) g.portfolio++; if (r.scopeMarketplace) g.marketplace++; if (r.scopeProductId) g.product++ }
console.log(`  by grain: campaign=${g.campaign} portfolio=${g.portfolio} marketplace=${g.marketplace} product=${g.product}`)
const advScoped = scoped.filter((r) => r.domain === 'advertising')
console.log(`  of which domain=advertising: ${advScoped.length}`)

console.log('\n═══ B · reach: campaigns writable vs total ═══')
const totalC = await prisma.campaign.count()
const enabled = await prisma.campaign.count({ where: { status: 'ENABLED' } })
const withExt = await prisma.campaign.count({ where: { externalCampaignId: { not: null } } })
const writable = await prisma.campaign.count({ where: { status: 'ENABLED', externalCampaignId: { not: null } } })
console.log(`  campaigns total=${int(totalC)} ENABLED=${int(enabled)} withExternalId=${int(withExt)} ENABLED∧external=${int(writable)}`)
const byMkt = await prisma.campaign.groupBy({ by: ['marketplace'], _count: true })
console.log(`  by marketplace: ${byMkt.map((m: any) => `${m.marketplace}=${m._count}`).join(' · ')}`)

console.log('\n═══ C · the write gate allowlist ═══')
try {
  const gate = await import('../src/services/advertising/ads-write-gate.service.js')
  console.log(`  exports: ${Object.keys(gate).join(', ')}`)
} catch (e: any) { console.log(`  (no ads-write-gate.service: ${e.message.slice(0,80)})`) }

console.log('\n═══ D · the one-row bucketing boundary ═══')
const rows = await prisma.$queryRaw<Array<{ id: string; kw: string; created: Date; ext: string|null; hasPerf: boolean; imp: bigint|null }>>`
  WITH f AS (SELECT DISTINCT ON ("entityId") "entityId" FROM "AdvertisingActionLog"
             WHERE "actionType"='create_keyword' AND "userId"='automation:auto-harvest' ORDER BY "entityId","createdAt" ASC),
  pp AS (SELECT "localEntityId" AS id, SUM(impressions)::bigint AS imp FROM "AmazonAdsDailyPerformance"
         WHERE "entityType"='AD_TARGET' GROUP BY 1)
  SELECT t.id, t."expressionValue" AS kw, t."createdAt" AS created, t."externalTargetId" AS ext,
         (pp.id IS NOT NULL) AS "hasPerf", pp.imp
  FROM "AdTarget" t JOIN f ON f."entityId"=t.id LEFT JOIN pp ON pp.id=t.id
  WHERE t."externalTargetId" IS NOT NULL
  ORDER BY t."createdAt"`
console.log(`  harvested keywords that DID reach Amazon: ${rows.length}`)
for (const r of rows) {
  const before = r.created < new Date('2026-07-05T00:00:00Z')
  const bucket = !r.hasPerf ? (before ? 'not-measured' : 'never-served') : (Number(r.imp ?? 0) === 0 ? 'never-served' : 'served')
  const alt    = Number(r.imp ?? 0) === 0 && before ? 'not-measured' : bucket
  console.log(`    ${String(r.kw).slice(0,34).padEnd(36)} created=${r.created.toISOString().slice(0,10)} ${before?'PRE ':'post'} hasPerf=${r.hasPerf?'Y':'n'} imp=${String(r.imp ?? '—').padStart(6)}  HV.5=${bucket.padEnd(13)} alt=${alt}${bucket!==alt?'   ⚠ DISAGREE':''}`)
}
await prisma.$disconnect()
