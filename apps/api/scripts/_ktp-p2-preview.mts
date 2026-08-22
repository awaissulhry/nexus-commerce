import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { previewKeywordTrackerRule, keywordRankFeedHealth } = await import('../src/services/advertising/ads-rule-preview.service.js')

const camps = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true }, take: 70 })
// the exact draft clicked on prod in Phase 0: IF Organic Rank > 50 THEN Set Bid to €0.80
const draft = {
  actions: [{ type: 'keyword-tracker', campaigns: camps.map((c) => ({ id: c.id })), bidFloor: 0.05, bidCeiling: null }],
  conditions: [{ conditions: [{ metric: 'Organic Rank', op: 'gt', value: '50' }], action: { op: 'set', value: '0.80' } }],
  scopeMarketplace: null,
}
const out = await previewKeywordTrackerRule(draft)
console.log('===JSON===' + JSON.stringify({
  feedHealth: await keywordRankFeedHealth(),
  preview: { ok: out.ok, error: out.error, windowDays: out.windowDays, selected: out.selected,
    measurable: out.measurable, inScope: out.inScope, matched: out.matched, noChange: out.noChange,
    rowCount: out.rows.length, suppressedMatched: out.suppressedMatched,
    suppressedUnflaggedMatched: out.suppressedUnflaggedMatched, campaignSuppressedMatched: out.campaignSuppressedMatched,
    sampleRows: out.rows.slice(0, 3) },
}, (_k, v) => typeof v === 'bigint' ? Number(v) : v, 1))
await prisma.$disconnect()
