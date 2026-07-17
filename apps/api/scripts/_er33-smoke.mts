/**
 * ER3.3 smoke — GET /dashboard: every recommendation count cross-checked
 * against a direct DB query; pacing block maths; anomalies carry internal
 * campaignId where campaign-scoped; summary/trend still serve presets AND
 * explicit ranges. Read-only throughout.
 */
import Fastify from 'fastify'

const routes = (await import('/Users/awais/nexus-commerce/apps/api/src/routes/ebay-ads.routes.js')).default
const prisma = (await import('/Users/awais/nexus-commerce/apps/api/src/db.js')).default
const { projectMonthEnd } = await import('/Users/awais/nexus-commerce/apps/api/src/services/marketing/ebay-ads-dashboard.service.js')
const app = Fastify()
await app.register(routes, { prefix: '/api' })

let failures = 0
const check = (label: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗ FAIL'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

const r = await app.inject({ method: 'GET', url: '/api/ebay-ads/dashboard' })
const j = r.json() as { recommendations: Array<{ type: string; count: number; criteria: string; samples: string[]; cta: { label: string; href: string } }>; pacing: { ceilings: Array<{ marketplace: string; mtdCents: number; capCents: number; pct: number; projectedCents: number }>; cpc: { campaigns: number; dailyBudgetCents: number; ydayFeesCents: number; utilizationPct: number | null; limitedCount: number } } }
check('GET /dashboard 200 with 5 recommendation types', r.statusCode === 200 && j.recommendations.length === 5, j.recommendations.map((x) => `${x.type}:${x.count}`).join(' '))
check('every row states criteria + CTA', j.recommendations.every((x) => x.criteria.length > 20 && x.cta.href.startsWith('/marketing/ads/ebay')))

// ── direct-DB cross-checks ────────────────────────────────────────────────────
const promoted = await prisma.ebayAd.findMany({
  where: { listingId: { not: null }, status: { notIn: ['STALE'] }, campaign: { status: { in: ['RUNNING', 'PAUSED'] } } },
  select: { listingId: true, bidPercentage: true, campaign: { select: { id: true, status: true, marketplace: true, fundingModel: true, bidPercentage: true } } },
})
const ids = [...new Set(promoted.map((a) => a.listingId!))]
const idx = await prisma.ebayListingIndex.findMany({ where: { itemId: { in: ids } }, select: { itemId: true, productIds: true } })
const unmatched = idx.filter((l) => (l.productIds ?? []).length === 0).length
const missing = await prisma.ebayListingEconomics.count({ where: { itemId: { in: ids }, dataStatus: 'MISSING_COGS' } })
const live = await prisma.ebayListingIndex.count({ where: { endedAt: null } })
const cpsPromoted = new Set(promoted.filter((a) => a.campaign.fundingModel === 'COST_PER_SALE').map((a) => a.listingId!))
const eco = new Map((await prisma.ebayListingEconomics.findMany({ where: { itemId: { in: ids } }, select: { itemId: true, breakEvenAdRatePct: true } })).map((e) => [e.itemId, e.breakEvenAdRatePct]))
let overBe = 0
for (const a of promoted) {
  if (a.campaign.fundingModel !== 'COST_PER_SALE' || a.campaign.status !== 'RUNNING') continue
  const rate = a.bidPercentage != null ? Number(a.bidPercentage.toString()) : a.campaign.bidPercentage != null ? Number(a.campaign.bidPercentage.toString()) : null
  const be = eco.get(a.listingId!)
  if (rate != null && be != null && rate > Number(be.toString()) + 0.05) overBe++
}
const byType = Object.fromEntries(j.recommendations.map((x) => [x.type, x.count]))
check('unmatched_listings count matches DB', byType.unmatched_listings === unmatched, `${byType.unmatched_listings} vs ${unmatched}`)
check('missing_costs count matches DB', byType.missing_costs === missing, `${byType.missing_costs} vs ${missing}`)
check('unpromoted_listings = live − promoted-CPS', byType.unpromoted_listings === Math.max(0, live - cpsPromoted.size), `${byType.unpromoted_listings} vs ${live}−${cpsPromoted.size}`)
check('rates_above_breakeven count matches DB', byType.rates_above_breakeven === overBe, `${byType.rates_above_breakeven} vs ${overBe}`)
const runningCount = await prisma.ebayCampaign.count({ where: { status: 'RUNNING' } })
check('campaigns_without_rules ≤ running campaigns', byType.campaigns_without_rules <= runningCount, `${byType.campaigns_without_rules} of ${runningCount} running`)

// ── pacing ───────────────────────────────────────────────────────────────────
const cl = j.pacing.ceilings[0]
check('ceiling row present with projection', !!cl && cl.projectedCents === projectMonthEnd(cl.mtdCents), cl ? `${cl.marketplace}: mtd=${cl.mtdCents} proj=${cl.projectedCents}` : 'none')
const cpcCamps = await prisma.ebayCampaign.findMany({ where: { status: 'RUNNING', fundingModel: 'COST_PER_CLICK', dailyBudget: { not: null } }, select: { dailyBudget: true } })
const budgetSum = cpcCamps.reduce((s, c) => s + Math.round(Number(c.dailyBudget!.toString()) * 100), 0)
check('CPC budget sum matches DB', j.pacing.cpc.campaigns === cpcCamps.length && j.pacing.cpc.dailyBudgetCents === budgetSum, `${j.pacing.cpc.campaigns} campaigns · ${j.pacing.cpc.dailyBudgetCents} vs ${budgetSum}`)
check('utilization null iff no budgets', budgetSum === 0 ? j.pacing.cpc.utilizationPct === null : j.pacing.cpc.utilizationPct != null)

// ── anomalies campaignId ─────────────────────────────────────────────────────
const an = await app.inject({ method: 'GET', url: '/api/ebay-ads/automation/anomalies' })
const anomalies = (an.json() as { anomalies: Array<{ type: string; campaignId?: string; entityId?: string }> }).anomalies
const campaignScoped = anomalies.filter((a) => a.type === 'campaign_ended_externally' || a.type === 'dynamic_rate_over_cap')
check('anomalies endpoint 200', an.statusCode === 200, `${anomalies.length} anomalies (${anomalies.map((a) => a.type).join(', ') || 'none'})`)
check('campaign-scoped anomalies carry internal campaignId', campaignScoped.every((a) => !!a.campaignId), campaignScoped.length ? `${campaignScoped.length} scoped, all with id` : 'none present (vacuously true)')

// ── summary/trend presets + explicit ranges ──────────────────────────────────
const s1 = await app.inject({ method: 'GET', url: '/api/ebay-ads/summary?preset=last30' })
const s2 = await app.inject({ method: 'GET', url: '/api/ebay-ads/summary?startDate=2026-06-01&endDate=2026-06-15' })
const t1 = await app.inject({ method: 'GET', url: '/api/ebay-ads/trend?startDate=2026-06-01&endDate=2026-06-15' })
check('summary preset + explicit range both 200', s1.statusCode === 200 && s2.statusCode === 200 && (s2.json() as { window: { preset: string } }).window.preset === 'custom')
check('trend explicit range 200', t1.statusCode === 200)

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`)
process.exit(failures === 0 ? 0 : 1)
