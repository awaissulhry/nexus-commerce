/**
 * HV page study — the WIRING, measured. READ-ONLY: no writes, no mutations.
 *
 * Builds on docs/2026-08-11-hv-keyword-harvest-study.md. Measures only what that study did not,
 * or what I actively doubt:
 *   1. the three rule populations (badge / grid / builder-created) — is the map missing a type?
 *   2. the TWO harvest engines and their different thresholds — what can each one ever see?
 *   3. how much of a preview is re-proposing work already done (no existence check in previewHarvest)
 *   4. the destination structure — is there anywhere to promote INTO?
 *   5. the suggestion queue, by action type and age
 *   6. what the harvest rules' executions actually reported
 *   7. observed CPC vs the four hard-coded graduation bids (0.50 / 0.60 / 0.65 / 0.75)
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))

console.log('\n═══ HV page — wiring ═══\n')

// ── 1. THREE rule populations ─────────────────────────────────────────────────
const BADGE = ['promote_to_exact', 'harvest_and_negate']            // RULE_TAB_ACTION_TYPES['keyword-harvest']
const BUILDER_SLUG = 'keyword-harvesting'                           // what RuleBuilder actually writes
const all = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: {
    id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, conditions: true,
    executionCount: true, lastExecutedAt: true, maxExecutionsPerDay: true, createdAt: true,
    scopeMarketplace: true, scopePortfolioId: true, scopeCampaignId: true, scopeProductId: true,
    maxDailyAdSpendCentsEur: true,
  },
})
const badgeRules = all.filter((r) => types(r.actions).some((t) => BADGE.includes(t)))
const builderRules = all.filter((r) => types(r.actions).includes(BUILDER_SLUG))
console.log(`advertising AutomationRule rows                                  ${int(all.length)}`)
console.log(`  BADGE population  RULE_TAB_ACTION_TYPES['keyword-harvest']     ${badgeRules.length}`)
console.log(`  GRID  population  ruleBelongsToTab(actions,'keyword-harvesting') 0  ← undefined key`)
console.log(`  BUILDER-created   actions[].type === 'keyword-harvesting'      ${builderRules.length}`)
console.log(`  builder rules ALSO in the badge population                     ${builderRules.filter((r) => badgeRules.includes(r)).length}`)

console.log(`\n── the badge's ${badgeRules.length} rules ──`)
console.log(`${pad('rule', 44)} ${pad('on', 3)} ${pad('level', 8)} ${pad('trigger', 26)} ${pad('execs', 7)} ${pad('cap/d', 6)} scope`)
for (const r of badgeRules) {
  const scope = [r.scopeMarketplace && `mkt=${r.scopeMarketplace}`, r.scopePortfolioId && 'portfolio', r.scopeCampaignId && 'campaign', r.scopeProductId && 'product'].filter(Boolean).join(' ') || 'ACCOUNT-WIDE'
  console.log(`${pad(r.name, 44)} ${pad(r.enabled ? 'ON' : '—', 3)} ${pad(String(r.autonomyLevel), 8)} ${pad(r.trigger, 26)} ${pad(int(r.executionCount), 7)} ${pad(String(r.maxExecutionsPerDay ?? '—'), 6)} ${scope}`)
  console.log(`     actions: ${types(r.actions).join(', ')}`)
  console.log(`     spend ceiling: ${r.maxDailyAdSpendCentsEur != null ? eur(r.maxDailyAdSpendCentsEur) : 'NONE'}`)
  const a = (Array.isArray(r.actions) ? r.actions : []) as Array<Record<string, unknown>>
  const hn = a.find((x) => x.type === 'harvest_and_negate')
  if (hn) console.log(`     harvest params: windowDays=${hn.windowDays ?? '(60)'} minSpendCents=${hn.minSpendCents ?? '(1000)'} minOrders=${hn.minOrders ?? '(2)'} gradBid=${hn.graduationBidEur ?? '(0.5)'} sources=${Array.isArray(hn.sources) ? (hn.sources as unknown[]).length : 'none'} destinations=${hn.destinations ? Object.keys(hn.destinations as object).length : 'none'}`)
  const pe = a.find((x) => x.type === 'promote_to_exact')
  if (pe) console.log(`     promote params: bidEur=${pe.bidEur ?? '(0.5)'} adGroupId=${pe.adGroupId ?? '(source ad group)'}`)
}

// every distinct action type in the account, so an unmapped one is visible
const typeCount = new Map<string, number>()
for (const r of all) for (const t of types(r.actions)) typeCount.set(t, (typeCount.get(t) ?? 0) + 1)
console.log(`\n── every action type in the account (${typeCount.size}) ──`)
console.log([...typeCount.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}=${n}`).join(' · '))

// ── 2. the TWO engines ────────────────────────────────────────────────────────
// A: previewHarvest       — 60d, ALL match types, orders >= minOrders, no cap
// B: SEARCH_TERM_CONVERTING — 30d minus the provisional tail, BROAD/PHRASE/null only, >= 2, cap 300
console.log('\n\n═══ 2 · the two harvest engines see different universes ═══\n')

const now = Date.now()
const win = (d: number) => new Date(now - d * 86_400_000)
const gb = async (days: number, matchFilter: object) => prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'campaignId', 'adGroupId'],
  where: { date: { gte: win(days) }, ...matchFilter },
  _sum: { orders7d: true, clicks: true, costMicros: true, sales7dCents: true, impressions: true },
})

const A60 = await gb(60, {})
const B30 = await gb(30, { OR: [{ matchType: { in: ['BROAD', 'PHRASE'] } }, { matchType: null }] })
const ordersOf = (r: { _sum: { orders7d: number | null } }) => r._sum.orders7d ?? 0

for (const min of [1, 2, 3]) {
  const a = A60.filter((r) => ordersOf(r) >= min)
  const b = B30.filter((r) => ordersOf(r) >= min)
  console.log(`minOrders >= ${min}   previewHarvest(60d, all match) ${pad(int(a.length), 6)}   SEARCH_TERM_CONVERTING(30d, broad/phrase/null) ${int(b.length)}`)
}
console.log(`\nCONVERTING_MIN_ORDERS env = ${process.env.NEXUS_CONVERTING_MIN_ORDERS ?? '(unset → 2)'}`)
console.log('  ↑ this is a `having` clause on the CONTEXT BUILDER. A rule condition can only tighten it.')

// what the 30-day/match-type filter costs
const A60ge2 = A60.filter((r) => ordersOf(r) >= 2)
const B30ge2 = B30.filter((r) => ordersOf(r) >= 2)
const keyOf = (r: { query: string; campaignId: string; adGroupId: string }) => `${r.query}|${r.campaignId}|${r.adGroupId}`
const bKeys = new Set(B30ge2.map(keyOf))
const onlyA = A60ge2.filter((r) => !bKeys.has(keyOf(r)))
console.log(`\ncandidates visible to previewHarvest but NEVER to promote_to_exact: ${onlyA.length} of ${A60ge2.length}`)

// match-type composition of the 60-day converting set — one groupBy, not N queries
const withMatch = await prisma.amazonAdsSearchTerm.groupBy({
  by: ['query', 'campaignId', 'adGroupId', 'matchType'],
  where: { date: { gte: win(60) } },
  _sum: { orders7d: true },
})
const byMatch = new Map<string, number>()
for (const r of withMatch) {
  if ((r._sum.orders7d ?? 0) < 2) continue
  const m = r.matchType ?? 'null(auto-targeting)'
  byMatch.set(m, (byMatch.get(m) ?? 0) + 1)
}
console.log(`match types among the 60-day converters (query×campaign×adgroup×matchType, >=2 orders): ${[...byMatch.entries()].sort((a, b) => b[1] - a[1]).map(([m, n]) => `${m}=${n}`).join(' · ')}`)

// ── 3. how much of a preview is already done? ─────────────────────────────────
console.log('\n\n═══ 3 · previewHarvest has no existence check — how much does it re-propose? ═══\n')
const agByExt = new Map<string, { id: string; name: string; campaignName: string }>()
for (const ag of await prisma.adGroup.findMany({ select: { id: true, name: true, externalAdGroupId: true, campaign: { select: { name: true } } } })) {
  if (ag.externalAdGroupId) agByExt.set(ag.externalAdGroupId, { id: ag.id, name: ag.name, campaignName: ag.campaign?.name ?? '' })
}
const positives = await prisma.adTarget.findMany({
  where: { kind: 'KEYWORD', isNegative: false },
  select: { adGroupId: true, expressionType: true, expressionValue: true, externalTargetId: true, bidCents: true, createdAt: true },
})
const posKey = new Set(positives.map((t) => `${t.adGroupId}|${t.expressionType.toUpperCase()}|${t.expressionValue.trim().toLowerCase()}`))
const posAnywhere = new Set(positives.filter((t) => t.expressionType.toUpperCase() === 'EXACT').map((t) => t.expressionValue.trim().toLowerCase()))

for (const [label, set] of [['minOrders>=2 (the default)', A60ge2], ['minOrders>=1', A60.filter((r) => ordersOf(r) >= 1)]] as const) {
  let inSourceAg = 0, exactAnywhere = 0, noLocalAg = 0
  for (const r of set) {
    const ag = agByExt.get(r.adGroupId)
    if (!ag) { noLocalAg++; continue }
    if (posKey.has(`${ag.id}|EXACT|${r.query.trim().toLowerCase()}`)) inSourceAg++
    if (posAnywhere.has(r.query.trim().toLowerCase())) exactAnywhere++
  }
  console.log(`${pad(label, 26)} candidates ${pad(int(set.length), 6)}  already EXACT in the SOURCE ad group ${pad(int(inSourceAg), 5)}  EXACT anywhere ${pad(int(exactAnywhere), 5)}  no local ad group ${int(noLocalAg)}`)
}

// ── 4. is there a destination to promote INTO? ────────────────────────────────
console.log('\n\n═══ 4 · the destination structure ═══\n')
const ags = await prisma.adGroup.findMany({ select: { id: true, name: true, externalAdGroupId: true, campaign: { select: { name: true, targetingType: true, status: true, marketplace: true } } } })
const role = (n: string) => { const u = (n || '').toUpperCase(); return u.includes('AUTO') ? 'AUTO' : u.includes('EXACT') ? 'EXACT' : u.includes('PHRASE') ? 'PHRASE' : u.includes('BROAD') ? 'BROAD' : 'unnamed' }
const roleCount = new Map<string, number>()
for (const ag of ags) roleCount.set(role(`${ag.campaign?.name ?? ''} ${ag.name}`), (roleCount.get(role(`${ag.campaign?.name ?? ''} ${ag.name}`)) ?? 0) + 1)
console.log(`ad groups: ${int(ags.length)} — by match role in the campaign/ad-group NAME:`)
console.log(`  ${[...roleCount.entries()].sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r}=${n}`).join(' · ')}`)
const autoCamps = await prisma.campaign.count({ where: { targetingType: 'AUTO' } })
const manCamps = await prisma.campaign.count({ where: { targetingType: 'MANUAL' } })
console.log(`campaigns: AUTO ${autoCamps} · MANUAL ${manCamps}`)

// where do the 60d converters actually come from?
const srcRole = new Map<string, number>()
for (const r of A60ge2) {
  const ag = agByExt.get(r.adGroupId)
  srcRole.set(ag ? role(`${ag.campaignName} ${ag.name}`) : 'no local ad group', (srcRole.get(ag ? role(`${ag.campaignName} ${ag.name}`) : 'no local ad group') ?? 0) + 1)
}
console.log(`the ${A60ge2.length} converters come from: ${[...srcRole.entries()].map(([r, n]) => `${r}=${n}`).join(' · ')}`)

// ── 5. the suggestion queue ───────────────────────────────────────────────────
console.log('\n\n═══ 5 · the proposal queue ═══\n')
const sugg = await prisma.adsRuleSuggestion.findMany({ select: { status: true, proposedAction: true, createdAt: true, ruleName: true, entityType: true, decidedAt: true } })
const byStatus = new Map<string, number>()
for (const s of sugg) byStatus.set(s.status, (byStatus.get(s.status) ?? 0) + 1)
console.log(`AdsRuleSuggestion: ${[...byStatus.entries()].map(([s, n]) => `${s}=${n}`).join(' · ')}`)
const byAct = new Map<string, number>()
for (const s of sugg) { const t = String((s.proposedAction as { type?: unknown } | null)?.type ?? 'unknown'); byAct.set(t, (byAct.get(t) ?? 0) + 1) }
console.log(`by proposed action: ${[...byAct.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}=${n}`).join(' · ')}`)
const pending = sugg.filter((s) => s.status === 'pending')
if (pending.length) {
  const ages = pending.map((s) => Math.floor((now - s.createdAt.getTime()) / 86_400_000)).sort((a, b) => a - b)
  console.log(`pending age (days): min ${ages[0]} · median ${ages[Math.floor(ages.length / 2)]} · max ${ages[ages.length - 1]}`)
  const byRule = new Map<string, number>()
  for (const s of pending) byRule.set(s.ruleName ?? '(unnamed)', (byRule.get(s.ruleName ?? '(unnamed)') ?? 0) + 1)
  console.log(`pending by rule: ${[...byRule.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([r, n]) => `${r}=${n}`).join(' · ')}`)
}
const harvestSugg = sugg.filter((s) => BADGE.includes(String((s.proposedAction as { type?: unknown } | null)?.type ?? '')))
console.log(`suggestions from a HARVEST action: ${harvestSugg.length}`)

// ── 6. what did the harvest rules actually report? ────────────────────────────
console.log('\n\n═══ 6 · harvest rule executions — what did they say? ═══\n')
for (const r of badgeRules) {
  const execs = await prisma.automationRuleExecution.findMany({
    where: { ruleId: r.id }, orderBy: { startedAt: 'desc' }, take: 400,
    select: { status: true, dryRun: true, startedAt: true, actionResults: true, errorMessage: true },
  })
  if (!execs.length) { console.log(`${pad(r.name, 44)} no executions stored`); continue }
  const byStat = new Map<string, number>()
  for (const e of execs) byStat.set(e.status, (byStat.get(e.status) ?? 0) + 1)
  let noChange = 0, wouldGraduate = 0, wouldNegate = 0, withHarvestOutput = 0
  for (const e of execs) {
    for (const a of (Array.isArray(e.actionResults) ? e.actionResults : []) as Array<Record<string, unknown>>) {
      const o = a.output as Record<string, unknown> | undefined
      if (!o || !BADGE.includes(String(a.type))) continue
      withHarvestOutput++
      if (o.noChange === true) noChange++
      if (typeof o.wouldGraduate === 'number') wouldGraduate += o.wouldGraduate
      if (typeof o.wouldNegate === 'number') wouldNegate += o.wouldNegate
    }
  }
  console.log(`${pad(r.name, 44)} last ${execs.length} execs · ${[...byStat.entries()].map(([s, n]) => `${s}=${n}`).join(' ')}`)
  console.log(`     harvest action outputs ${withHarvestOutput} · noChange ${noChange} · Σ wouldGraduate ${wouldGraduate} · Σ wouldNegate ${wouldNegate} · newest ${execs[0].startedAt.toISOString().slice(0, 16)}`)
  const errs = execs.filter((e) => e.errorMessage).slice(0, 2)
  for (const e of errs) console.log(`     error: ${e.errorMessage?.slice(0, 140)}`)
}

// ── 7. observed CPC vs the four constants ─────────────────────────────────────
console.log('\n\n═══ 7 · what a graduated keyword SHOULD bid vs the four constants ═══\n')
console.log('constants in the code: promote_to_exact 0.50 · harvest_and_negate 0.50 · adapter "suggested" 0.75 · templates 0.60 / 0.65')
const cpcs: number[] = []
for (const r of A60.filter((x) => ordersOf(x) >= 1)) {
  const clicks = r._sum.clicks ?? 0
  const cost = Math.round(Number(r._sum.costMicros ?? 0n) / 10000)
  if (clicks > 0) cpcs.push(cost / clicks / 100)
}
cpcs.sort((a, b) => a - b)
const q = (p: number) => cpcs.length ? cpcs[Math.min(cpcs.length - 1, Math.floor(cpcs.length * p))] : 0
console.log(`observed CPC on ${cpcs.length} converting terms (>=1 order, 60d):`)
console.log(`  min €${q(0).toFixed(2)} · p25 €${q(0.25).toFixed(2)} · median €${q(0.5).toFixed(2)} · p75 €${q(0.75).toFixed(2)} · p90 €${q(0.9).toFixed(2)} · max €${q(1).toFixed(2)}`)
for (const c of [0.5, 0.6, 0.65, 0.75]) {
  const over = cpcs.filter((x) => x < c).length
  console.log(`  a flat €${c.toFixed(2)} OVERPAYS on ${over}/${cpcs.length} (${Math.round((over / Math.max(1, cpcs.length)) * 100)}%) and underbids the rest`)
}

// ── 8. freshness + engine runs ────────────────────────────────────────────────
console.log('\n\n═══ 8 · freshness and the engines ═══\n')
const st = await prisma.amazonAdsSearchTerm.aggregate({ _max: { date: true }, _min: { date: true }, _count: true })
console.log(`AmazonAdsSearchTerm: ${int(st._count)} rows · ${st._min.date?.toISOString().slice(0, 10)} → ${st._max.date?.toISOString().slice(0, 10)} (${st._max.date ? Math.floor((now - st._max.date.getTime()) / 86_400_000) : '?'} days old)`)
// HV.1c — this block used to crash the whole script at §8. `CronRun` has `jobName`, not `name`,
// and carries `outputSummary` (a string) rather than `result`/`durationMs` — neither field exists
// on the model. `_hv-page-forensics.mts` §4 always had it right, which is why the same data was
// available there and this section had simply never run.
//
// 🔴 And the job list was wrong in a way that outlived the crash: `ads-v1-export-ingest` carries
// the v1 unified export of STRUCTURE data (campaigns, ad groups, targets), NOT search terms. The
// search-term chain is ads-report-create-st → ads-report-poll → ads-report-ingest. HV.1 read
// `ingested=0 rows=0` off the export job and concluded the search-term feed had stalled. It had
// not. See `_hv-2a-ingest.mts` and the doc's `## HV.2a` section.
for (const jobName of ['ads-auto-harvest', 'ads-coverage-engine', 'ads-report-create-st', 'ads-report-poll', 'ads-report-ingest', 'ads-v1-export-ingest']) {
  const runs = await prisma.cronRun.findMany({ where: { jobName }, orderBy: { startedAt: 'desc' }, take: 6, select: { startedAt: true, status: true, outputSummary: true, errorMessage: true } })
  console.log(`\n${jobName}: ${runs.length ? '' : 'NO RUNS RECORDED'}`)
  for (const r of runs) console.log(`  ${r.startedAt.toISOString().slice(0, 16)} ${pad(r.status, 8)} ${(r.outputSummary ?? '').slice(0, 120)}${r.errorMessage ? `  ERR: ${r.errorMessage.slice(0, 60)}` : ''}`)
}

await prisma.$disconnect()
console.log('\n═══ done ═══\n')
