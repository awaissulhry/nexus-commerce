import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { previewSovRule } = await import('../src/services/advertising/ads-sov-preview.service.js')

// pick a few real campaigns that have keyword targets
const camps = await prisma.campaign.findMany({
  where: { adGroups: { some: { targets: { some: { kind: 'KEYWORD', isNegative: false } } } } },
  select: { id: true, name: true, marketplace: true, adProduct: true, targetingType: true, dailyBudget: true },
  take: 400,
})
const withKw = [] as typeof camps
for (const c of camps) {
  const n = await prisma.adTarget.count({ where: { kind: 'KEYWORD', isNegative: false, adGroup: { campaignId: c.id } } })
  if (n >= 20) withKw.push(c)
  if (withKw.length >= 4) break
}
const draft = (conds: Array<{ metric: string; op: string; value: string }>, op = 'incPct', value = '20') => ({
  actions: [{
    type: 'sov', control: 'manual',
    campaigns: withKw.map((c) => ({ id: c.id, name: c.name, marketplace: c.marketplace, adProduct: c.adProduct, targetingType: c.targetingType, dailyBudget: c.dailyBudget })),
    bidFloor: 0.05, bidCeiling: null,
    schedule: { frequency: 'daily', time: '00:00', timezone: 'Europe/Rome' },
  }],
  conditions: [{ match: 'all', lookback: 'Last 30 Days', exclude: 'Last 2 Days', conditions: conds, action: { op, value } }],
  scopeMarketplace: null as string | null,
})

console.log(`campaigns picked: ${withKw.map((c) => `${c.marketplace} "${c.name}"`).join(' · ')}`)

const show = (label: string, r: Awaited<ReturnType<typeof previewSovRule>>) => {
  console.log(`\n=== ${label}`)
  console.log(`  ok=${r.ok} ${r.error ?? ''} ${r.untranslatable?.length ? 'untranslatable=' + JSON.stringify(r.untranslatable) : ''}`)
  console.log(`  census: selected=${r.selected} campaigns · selectedTargets=${r.selectedTargets} positive targets in them · eligible=${r.eligible} KEYWORD · measurable=${r.measurable} carry a market share · inScope=${r.inScope} · matched=${r.matched} · noChange=${r.noChange} · rows=${r.rows.length}`)
  console.log(`  periods: ${r.periods.map((p) => `${p.marketplace}=${p.week ?? 'refused'}${p.ageDays != null ? `(${p.ageDays}d)` : ''}${p.refused ? ' REFUSED' : ''}`).join(' · ')}`)
  for (const row of r.rows.slice(0, 5)) console.log(`    ${row.marketplace} "${row.keyword}" [${row.matchType}] ${row.status} sov=${(row.sovPct*100).toFixed(2)}% conc=${row.concentrationPct != null ? (row.concentrationPct*100).toFixed(0)+'%' : '—'} €${row.currentEur.toFixed(2)} → €${row.proposedEur.toFixed(2)} ${row.clamped ? '(clamped)' : ''} ${row.refused ? 'REFUSED: ' + row.refused.slice(0,60) : ''}`)
}

show('A · IF Share of Voice < 1% → Increase Bid 20%', await previewSovRule(draft([{ metric: 'Share of Voice', op: 'lt', value: '1' }])))
show('B · IF Share of Voice < 100% (matches everything eligible)', await previewSovRule(draft([{ metric: 'Share of Voice', op: 'lt', value: '100' }])))
show('C · IF Share of Voice > 99% (matches nothing)', await previewSovRule(draft([{ metric: 'Share of Voice', op: 'gt', value: '99' }])))
show('D · a removed metric must REFUSE the whole preview', await previewSovRule(draft([{ metric: 'Impression Share', op: 'lt', value: '5' }])))
show('E · Campaign Concentration < 100% (cannibalised only)', await previewSovRule(draft([{ metric: 'Campaign Concentration', op: 'lt', value: '100' }])))

// F · scope must bind
const d = draft([{ metric: 'Share of Voice', op: 'lt', value: '100' }]); d.scopeMarketplace = 'DE'
show('F · same rule scoped to DE', await previewSovRule(d))
const d2 = draft([{ metric: 'Share of Voice', op: 'lt', value: '100' }]); d2.scopeMarketplace = 'all'
show("G · scopeMarketplace 'all' must mean UNSCOPED, not literal 'all'", await previewSovRule(d2))

// H · nothing was written
const changed = await prisma.adTarget.count({ where: { updatedAt: { gte: new Date(Date.now() - 120_000) } } })
console.log(`\n### WRITE CHECK: AdTarget rows updated in the last 2 minutes: ${changed} (dryRun must write nothing)`)
await prisma.$disconnect()
