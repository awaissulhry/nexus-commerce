/**
 * NEG.X — the case for both actions, re-derived. READ-ONLY. Nothing here writes.
 *
 * Run BEFORE and AFTER. Before: it is the evidence for two proposals. After: it is the check that
 * the page's own writes did what they said.
 *
 * 🔴 The question that decides action one is not "should we delete it" but "can we" —
 * `AutomationRuleExecution.rule` is declared `onDelete: Cascade`, so a delete takes the rule's
 * entire execution history with it. That history is what NEG.8's ledger and the weekly digest read.
 */
import '../src/env.js'
const { normaliseNegTerm } = await import('../src/services/advertising/negatives.service.js')
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const h = (s: string) => console.log(`\n─── ${s} ${'─'.repeat(Math.max(0, 74 - s.length))}`)

console.log('\n═══ NEG.X — the two cases, re-derived ═══\n')

// ── baseline the page's own numbers ───────────────────────────────────────────────────────────
h('0 · baseline')
const [negatives, orphaned, retired, reviews] = await Promise.all([
  prisma.adTarget.count({ where: { isNegative: true } }),
  prisma.adTarget.count({ where: { isNegative: true, orphanedAt: { not: null } } }),
  prisma.adTarget.count({ where: { retiredAt: { not: null } } }),
  prisma.adNegativeReview.count(),
])
console.log(`  negatives ${int(negatives)} · orphaned ${orphaned} · retired via Nexus ${retired} · reviews ${reviews} of 132`)

const NEG_ACTIONS = ['harvest_and_negate', 'add_negative_exact', 'add_negative_phrase', 'sync_negatives_across_campaigns', 'negative-targeting']
const allRules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: {
    id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true,
    conditions: true, maxExecutionsPerDay: true, executionCount: true, createdAt: true,
    scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
  },
})
const actionTypes = (r: (typeof allRules)[number]) =>
  (Array.isArray(r.actions) ? (r.actions as Array<Record<string, unknown>>) : []).map((a) => String(a?.type ?? ''))
const negRules = allRules.filter((r) => actionTypes(r).some((t) => NEG_ACTIONS.includes(t)))
console.log(`  negation rules ${negRules.length} · all PROPOSE: ${negRules.every((r) => r.autonomyLevel === 'PROPOSE')} · carrying a scope: ${negRules.filter((r) => r.scopeMarketplace || r.scopePortfolioId || r.scopeCampaignId || r.scopeProductId).length}`)

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ACTION ONE — Account-wide negative sync
// ══════════════════════════════════════════════════════════════════════════════════════════════
h('1 · Account-wide negative sync — the four numbers')
const sync = negRules.find((r) => r.name === 'Account-wide negative sync')
if (!sync) { console.log('  🔴 RULE NOT FOUND — it may already be gone'); }
else {
  console.log(`  enabled=${sync.enabled} · ${sync.autonomyLevel} · trigger ${sync.trigger} · cap ${sync.maxExecutionsPerDay}/day · executionCount ${int(sync.executionCount)}`)
  console.log(`  actions ${JSON.stringify(sync.actions)}`)
  console.log(`  conditions ${JSON.stringify(sync.conditions)}`)

  // (a) has it ever reached its write?
  const execRows = await prisma.automationRuleExecution.count({ where: { ruleId: sync.id } })
  const sample = await prisma.automationRuleExecution.findMany({
    where: { ruleId: sync.id }, orderBy: { startedAt: 'desc' }, take: 2000,
    select: { actionResults: true, triggerData: true, startedAt: true },
  })
  let ok = 0, failed = 0
  const errs = new Map<string, number>()
  for (const e of sample) {
    for (const a of (Array.isArray(e.actionResults) ? (e.actionResults as Array<Record<string, unknown>>) : [])) {
      if (a?.type !== 'sync_negatives_across_campaigns') continue
      if (a.ok) ok++
      else { failed++; const m = String(a.error ?? '—'); errs.set(m, (errs.get(m) ?? 0) + 1) }
    }
  }
  console.log(`  (a) execution rows ${int(execRows)} · in the last ${int(sample.length)}: reached the write ${ok} · failed ${int(failed)}`)
  for (const [m, n] of errs) console.log(`        ${int(n)}× "${m}"`)

  // (b) the duplicate
  const sameTrigger = negRules.filter((r) => r.id !== sync.id && r.trigger === sync.trigger)
  console.log(`  (b) rules on the SAME trigger (${sync.trigger}): ${sameTrigger.length}`)
  for (const r of sameTrigger) {
    console.log(`        ${r.enabled ? 'ON ' : 'off'} ${r.name} — ${actionTypes(r).join(', ')} · conditions ${JSON.stringify(r.conditions)}`)
  }

  // (c) what it would have negated — the decision number
  const since60 = new Date(Date.now() - 60 * 86400_000)
  const trig = await prisma.automationRuleExecution.findMany({
    where: { ruleId: sync.id, startedAt: { gte: since60 } }, select: { triggerData: true }, take: 8000,
  })
  const targetIds = new Set<string>()
  for (const e of trig) {
    const td = (e.triggerData ?? {}) as { adTarget?: { id?: string } }
    if (td.adTarget?.id) targetIds.add(String(td.adTarget.id))
  }
  const targets = await prisma.adTarget.findMany({
    where: { id: { in: [...targetIds] } },
    select: { id: true, expressionValue: true, kind: true, adGroup: { select: { campaign: { select: { marketplace: true } } } } },
  })
  const st60 = await prisma.amazonAdsSearchTerm.groupBy({
    by: ['query'], where: { date: { gte: since60 } },
    _sum: { orders7d: true, sales7dCents: true },
  })
  const perf = new Map(st60.map((x) => [normaliseNegTerm(x.query), { o: x._sum.orders7d ?? 0, s: x._sum.sales7dCents ?? 0 }]))
  const converting: Array<{ term: string; o: number; s: number; mk: string }> = []
  let emptyExpr = 0
  for (const t of targets) {
    const k = normaliseNegTerm(t.expressionValue ?? '')
    if (!k) { emptyExpr++; continue }
    const p = perf.get(k)
    if ((p?.o ?? 0) >= 1) converting.push({ term: k, o: p!.o, s: p!.s, mk: t.adGroup?.campaign?.marketplace ?? '—' })
  }
  converting.sort((a, b) => b.s - a.s)
  console.log(`  (c) targets its trigger selected in 60d: ${targets.length} · empty expressionValue (AUTO): ${emptyExpr}`)
  console.log(`      🔴 of those, terms that CONVERTED: ${converting.length}`)
  for (const c of converting.slice(0, 6)) console.log(`        "${c.term}" ${c.o} orders ${eur(c.s)} (${c.mk})`)

  // (d) the blast radius, the handler's own selection
  const byMarket = await prisma.campaign.groupBy({
    by: ['marketplace'], where: { status: 'ENABLED', externalCampaignId: { not: null } }, _count: { _all: true },
  })
  console.log(`  (d) ENABLED campaigns per marketplace (one execution touches ONE market):`)
  for (const m of byMarket.sort((a, b) => b._count._all - a._count._all)) console.log(`        ${m.marketplace} ${m._count._all}`)

  // 🔴 (e) THE BLOCKING QUESTION — does a delete cascade?
  h('1e · 🔴 does deleting the rule destroy its history?')
  console.log(`  schema: AutomationRuleExecution.rule is declared \`onDelete: Cascade\``)
  console.log(`  🔴 deleting this rule would DELETE ${int(execRows)} execution rows with it`)
  const logsFromThose = await prisma.advertisingActionLog.count({
    where: { executionId: { in: (await prisma.automationRuleExecution.findMany({ where: { ruleId: sync.id }, select: { id: true }, take: 20000 })).map((x) => x.id) } },
  })
  console.log(`  AdvertisingActionLog rows referencing those executions: ${int(logsFromThose)}`)
  console.log(`  → NEG.8's ledger and the weekly digest both read AutomationRuleExecution.`)
  console.log(`  🔴 RECOMMENDATION: DISABLE, do not delete. An inert rule is harmless; a hole in the`)
  console.log(`     audit trail is not — and 16k rows of "this rule never worked" IS the evidence.`)
}

// ══════════════════════════════════════════════════════════════════════════════════════════════
// ACTION TWO — protezioni
// ══════════════════════════════════════════════════════════════════════════════════════════════
h('2 · protezioni — the split the operator needs')
const GRAM = 'protezioni'
const since = new Date(Date.now() - 60 * 86400_000)
const rows = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'adGroupId', 'campaignId', 'marketplace'],
  where: { date: { gte: since } },
  _sum: { impressions: true, clicks: true, costMicros: true, orders7d: true, sales7dCents: true },
})
/** Amazon negative-PHRASE semantics: a contiguous token run. */
const tokenMatch = (q: string, g: string) => {
  const w = normaliseNegTerm(q).split(' ').filter(Boolean)
  const t = normaliseNegTerm(g).split(' ').filter(Boolean)
  if (!t.length || t.length > w.length) return false
  for (let i = 0; i + t.length <= w.length; i++) {
    let ok = true
    for (let j = 0; j < t.length; j++) if (w[i + j] !== t[j]) { ok = false; break }
    if (ok) return true
  }
  return false
}
const hits = rows.filter((r) => tokenMatch(r.query, GRAM))
const looseHits = rows.filter((r) => normaliseNegTerm(r.query).includes(GRAM))
const totCost = hits.reduce((a, r) => a + Math.round(Number(r._sum.costMicros ?? 0n) / 10000), 0)
const totClicks = hits.reduce((a, r) => a + (r._sum.clicks ?? 0), 0)
const totOrders = hits.reduce((a, r) => a + (r._sum.orders7d ?? 0), 0)
const distinctTerms = new Set(hits.map((r) => r.query)).size
const looseTerms = new Set(looseHits.map((r) => r.query)).size
console.log(`  ${eur(totCost)} · ${int(totClicks)} clicks · ${int(totOrders)} orders · ${int(distinctTerms)} terms (contiguous)`)
console.log(`  loose (substring) terms ${int(looseTerms)} — 1-gram, so contiguous and loose should AGREE: ${distinctTerms === looseTerms ? 'they do' : `🔴 they differ by ${looseTerms - distinctTerms}`}`)
const markets = new Map<string, number>()
for (const r of hits) markets.set(r.marketplace, (markets.get(r.marketplace) ?? 0) + Math.round(Number(r._sum.costMicros ?? 0n) / 10000))
console.log(`  markets: ${[...markets].map(([m, c]) => `${m} ${eur(c)}`).join(' · ')}`)

// the split, per campaign then per ad group
const campaigns = await prisma.campaign.findMany({
  select: { id: true, name: true, externalCampaignId: true, marketplace: true, liveBidWritesEnabled: true, targetingType: true },
})
const cByExt = new Map(campaigns.filter((c) => c.externalCampaignId).map((c) => [c.externalCampaignId as string, c]))
const adGroups = await prisma.adGroup.findMany({ select: { name: true, externalAdGroupId: true } })
const agName = new Map(adGroups.filter((g) => g.externalAdGroupId).map((g) => [g.externalAdGroupId as string, g.name]))

type Cell = { cost: number; clicks: number; terms: Set<string>; ags: Map<string, number> }
const perCampaign = new Map<string, Cell>()
for (const r of hits) {
  const c = perCampaign.get(r.campaignId) ?? { cost: 0, clicks: 0, terms: new Set<string>(), ags: new Map<string, number>() }
  const cost = Math.round(Number(r._sum.costMicros ?? 0n) / 10000)
  c.cost += cost; c.clicks += r._sum.clicks ?? 0; c.terms.add(r.query)
  c.ags.set(r.adGroupId, (c.ags.get(r.adGroupId) ?? 0) + cost)
  perCampaign.set(r.campaignId, c)
}
const ranked = [...perCampaign].sort((a, b) => b[1].cost - a[1].cost)
console.log(`\n  per campaign, by spend — ${ranked.length} campaigns, ${int([...perCampaign.values()].reduce((a, c) => a + c.ags.size, 0))} ad groups total:`)
let cum = 0
ranked.forEach(([extId, cell], i) => {
  cum += cell.cost
  const c = cByExt.get(extId)
  const allow = c?.liveBidWritesEnabled ? '' : '  🔴 NOT on the write allowlist'
  console.log(`    ${String(i + 1).padStart(2)}. ${(c?.name ?? extId).padEnd(34)} ${eur(cell.cost).padStart(9)} · ${String(cell.clicks).padStart(3)} clicks · ${cell.ags.size} ad groups · ${cell.terms.size} terms · ${c?.targetingType ?? '—'}${allow}`)
  if (i < 3) console.log(`         cumulative ${eur(cum)} = ${((cum / totCost) * 100).toFixed(0)}% of the spend`)
})

h('2b · the four rails, re-run')
const { getWastefulWords } = await import('../src/services/advertising/negatives-ngrams.service.js')
const ww = await getWastefulWords({ market: 'all', window: 60 })
const g = ww.wasteful.find((w) => w.gram === GRAM)
if (!g) console.log('  🔴 protezioni is no longer in the wasteful list')
else {
  console.log(`  winning-gram collision : ${g.collisions.length === 0 ? 'clear' : `🔴 ${g.collisions.map((c) => c.gram).join(', ')}`}`)
  console.log(`  converting terms       : ${g.convertingTerms.length === 0 ? 'clear' : `🔴 ${g.convertingTerms.length}`}`)
  console.log(`  protected terms        : ${g.protectedBy.length === 0 ? 'clear' : `🔴 ${g.protectedBy.map((p) => p.term).join(', ')}`}`)
  console.log(`  the gram floor         : ${g.floorFailures.length === 0 ? 'clear' : `🔴 ${g.floorFailures.join(' · ')}`}`)
  console.log(`  → actionable: ${g.actionable ? 'YES' : '🔴 NO'} · blocks ${int(g.catches)} terms · ${int(g.adGroups)} ad groups (${int(g.adGroupsWritable)} writable, ${int(g.adGroupsAlreadyNegated)} already carry it)`)
}

h('3 · the detectors — the control for after')
const { getAttention } = await import('../src/services/advertising/negatives-attention.service.js')
const a30 = await getAttention({ market: 'all', window: 30 })
console.log(`  Detector A ${a30.conflicts.total} · Detector B ${a30.suppressed.total} · split-brain ${a30.splitBrain.total} · Detector C (inbound) ${a30.inbound?.total ?? 'n/a'}`)
console.log(`  🔴 all four must be UNCHANGED after the writes: the new negations carry a create log,`)
console.log(`     so Detector C's fourth condition must exclude them.`)

await prisma.$disconnect()
console.log('\n═══ done — nothing was written ═══\n')
