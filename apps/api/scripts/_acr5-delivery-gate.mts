/**
 * ACR Stage 5 — verify the report dormancy gate against prod BEFORE it runs a cycle. READ-ONLY.
 *
 * Calls deliveringAdProducts() directly, so what prints is exactly what the cycles will do.
 * The property that matters: it must skip SB/SD (never delivered) and keep every SP pair
 * (€22k of real spend). A gate that silently dropped SP would be far worse than the waste
 * it was written to remove.
 *
 * Usage: cd apps/api && npx tsx scripts/_acr5-delivery-gate.mts
 */
import { resolve } from 'path'
import { config } from 'dotenv'
config(); config({ path: resolve('/Users/awais/nexus-commerce/.env') })

const { PrismaClient } = await import('@prisma/client')
const prisma = new PrismaClient()
const { deliveringAdProducts } = await import('../src/services/advertising/ads-reports.service.js')

const profiles = await prisma.amazonAdsConnection.findMany({
  where: { isActive: true }, select: { marketplace: true },
})
const withCampaigns = await prisma.campaign.groupBy({ by: ['marketplace'], _count: { _all: true } })
const live = new Set(withCampaigns.filter(c => c._count._all > 0).map(c => c.marketplace))
const marketplaces = [...new Set(profiles.map(p => p.marketplace))].filter(m => live.has(m))

const keep = await deliveringAdProducts(marketplaces)
const ALL = ['SPONSORED_PRODUCTS', 'SPONSORED_DISPLAY', 'SPONSORED_BRANDS'] as const

console.log(`\nMarketplaces surviving the campaign filter: ${marketplaces.join(', ') || '(none)'}\n`)
console.log('MARKETPLACE  AD PRODUCT           GATE     WHY')
console.log('─'.repeat(74))
let kept = 0, skipped = 0
for (const m of marketplaces.sort()) {
  for (const p of ALL) {
    const on = keep.get(m)?.has(p) ?? false
    const enabled = await prisma.campaign.count({ where: { marketplace: m, adProduct: p, status: 'ENABLED' } })
    const impr = await prisma.amazonAdsDailyPerformance.aggregate({
      where: { marketplace: m, adProduct: p, date: { gte: new Date(Date.now() - 14 * 86_400_000) } },
      _sum: { impressions: true },
    })
    const why = on
      ? [enabled > 0 ? `${enabled} enabled` : null, (impr._sum.impressions ?? 0) > 0 ? `${impr._sum.impressions} impr/14d` : null].filter(Boolean).join(' + ')
      : 'no enabled campaigns, no delivery in 14d'
    on ? kept++ : skipped++
    console.log(`${m.padEnd(13)}${p.padEnd(21)}${(on ? 'REPORT' : 'skip').padEnd(9)}${why}`)
  }
}

const perCycle = kept
console.log(`\nPer campaign-cycle: ${kept} jobs requested, ${skipped} skipped (was ${kept + skipped}).`)
console.log(`Reduction: ${Math.round((skipped / (kept + skipped)) * 100)}% of campaign-report jobs.`)

// The safety property, asserted rather than eyeballed.
const spPairs = marketplaces.filter(m => keep.get(m)?.has('SPONSORED_PRODUCTS'))
const spEnabled = await prisma.campaign.groupBy({
  by: ['marketplace'], where: { adProduct: 'SPONSORED_PRODUCTS', status: 'ENABLED' }, _count: { _all: true },
})
const spExpected = spEnabled.filter(r => r._count._all > 0 && marketplaces.includes(r.marketplace)).map(r => r.marketplace)
const lost = spExpected.filter(m => !spPairs.includes(m))
console.log(`\nSAFETY — every marketplace with ENABLED SP campaigns still reports: ${lost.length === 0 ? 'PASS' : `FAIL (lost ${lost.join(', ')})`}`)
console.log(`         SP marketplaces kept: ${spPairs.join(', ') || '(none)'}`)
void perCycle
await prisma.$disconnect(); process.exit(0)
