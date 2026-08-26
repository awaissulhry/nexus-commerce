/**
 * PLC — Placement tab study. READ-ONLY: no writes, no mutations.
 *
 * The Placement tab lists rules whose actions are `set_placement_multiplier` or
 * `defend_top_of_search`. Those actions write `Campaign.dynamicBidding.placementBidding` —
 * the per-campaign bid multiplier Amazon applies at Top of Search / Rest of Search / Product
 * Pages. This measures the state of that lever across the account: who has it set, to what,
 * what each placement is actually worth, and which engines are allowed to move it.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`

console.log('\n═══ PLC — Placement: the lever, and who holds it ═══\n')

// ── 1. the rules on this tab ──────────────────────────────────────────────────
const PLACEMENT_ACTIONS = ['set_placement_multiplier', 'defend_top_of_search']
const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, executionCount: true, lastExecutedAt: true, scopeCampaignId: true, scopeMarketplace: true },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const onTab = rules.filter((r) => types(r.actions).some((t) => PLACEMENT_ACTIONS.includes(t)))
console.log(`Rules the Placement tab lists: ${onTab.length}`)
console.log(`${pad('rule', 46)} ${pad('enabled', 8)} ${pad('level', 8)} ${pad('trigger', 20)} ${pad('execs', 6)} last run`)
for (const r of onTab) {
  console.log(`${pad(r.name, 46)} ${pad(String(r.enabled), 8)} ${pad(String(r.autonomyLevel), 8)} ${pad(r.trigger, 20)} ${pad(String(r.executionCount), 6)} ${r.lastExecutedAt?.toISOString().slice(0, 10) ?? 'never'}`)
}
const byAction = new Map<string, number>()
for (const r of onTab) for (const t of types(r.actions)) if (PLACEMENT_ACTIONS.includes(t)) byAction.set(t, (byAction.get(t) ?? 0) + 1)
console.log(`  by action: ${[...byAction].map(([t, n]) => `${t}=${n}`).join(' · ')}`)

// ── 2. the lever itself: what is actually set on the 220 campaigns ────────────
const camps = await prisma.campaign.findMany({
  where: { channel: 'AMAZON' as never },
  select: { id: true, name: true, marketplace: true, status: true, dynamicBidding: true, biddingStrategy: true, pinPlacement: true, liveBidWritesEnabled: true },
}).catch(() => prisma.campaign.findMany({
  select: { id: true, name: true, marketplace: true, status: true, dynamicBidding: true, biddingStrategy: true, pinPlacement: true, liveBidWritesEnabled: true },
}))

interface PB { placement: string; percentage: number }
const readPB = (c: (typeof camps)[number]): PB[] => {
  const db = (c.dynamicBidding ?? {}) as { placementBidding?: PB[] }
  return Array.isArray(db.placementBidding) ? db.placementBidding : []
}
const LANES = ['PLACEMENT_TOP', 'PLACEMENT_REST_OF_SEARCH', 'PLACEMENT_PRODUCT_PAGE']
const nonZero = new Map<string, number>()
const setAtAll = new Map<string, number>()
const sums = new Map<string, number[]>()
let anyMultiplier = 0
for (const c of camps) {
  const pb = readPB(c)
  let any = false
  for (const lane of LANES) {
    const hit = pb.find((p) => p.placement === lane)
    if (hit) {
      setAtAll.set(lane, (setAtAll.get(lane) ?? 0) + 1)
      if (hit.percentage !== 0) { nonZero.set(lane, (nonZero.get(lane) ?? 0) + 1); any = true }
      const arr = sums.get(lane) ?? []; arr.push(hit.percentage); sums.set(lane, arr)
    }
  }
  if (any) anyMultiplier++
}
console.log(`\n── the placement multiplier, across ${camps.length} campaigns ──`)
console.log(`${pad('lane', 26)} ${pad('present', 9)} ${pad('non-zero', 9)} median   max`)
for (const lane of LANES) {
  const arr = (sums.get(lane) ?? []).slice().sort((a, b) => a - b)
  const med = arr.length ? arr[Math.floor(arr.length / 2)] : 0
  const max = arr.length ? arr[arr.length - 1] : 0
  console.log(`${pad(lane, 26)} ${pad(String(setAtAll.get(lane) ?? 0), 9)} ${pad(String(nonZero.get(lane) ?? 0), 9)} ${String(med).padStart(6)}%  ${String(max).padStart(5)}%`)
}
console.log(`  campaigns with ANY non-zero multiplier: ${anyMultiplier} of ${camps.length}`)

// Amazon's own bidding strategy — the multiplier only means something in context.
const byStrat = new Map<string, number>()
for (const c of camps) byStrat.set(String(c.biddingStrategy ?? 'null'), (byStrat.get(String(c.biddingStrategy ?? 'null')) ?? 0) + 1)
console.log(`\nbidding strategy: ${[...byStrat].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
console.log(`pinPlacement (automation forbidden to touch placement): ${camps.filter((c) => c.pinPlacement).length}`)
console.log(`liveBidWritesEnabled (write-gate open):                 ${camps.filter((c) => c.liveBidWritesEnabled).length} of ${camps.length}`)

// ── 3. what each placement is actually worth ──────────────────────────────────
const since = new Date(Date.now() - 60 * 86_400_000)
const perf = await prisma.amazonAdsPlacementReport.groupBy({
  by: ['placement', 'marketplace'],
  where: { date: { gte: since } },
  _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
})
console.log(`\n── what each placement returns, 60d, by market ──`)
console.log(`${pad('placement', 26)} ${pad('mkt', 4)} ${pad('impr', 11)} ${pad('clicks', 8)} ${pad('spend', 10)} ${pad('sales', 11)} ${pad('ROAS', 6)} ${pad('CPC', 8)} CVR`)
const order = ['Top of Search on-Amazon', 'Other on-Amazon', 'Detail Page on-Amazon']
for (const p of perf.sort((a, b) => (order.indexOf(a.placement) - order.indexOf(b.placement)) || a.marketplace.localeCompare(b.marketplace))) {
  const im = p._sum.impressions ?? 0, cl = p._sum.clicks ?? 0
  const sp = Number(p._sum.costMicros ?? 0n) / 1e6, sa = (p._sum.sales7dCents ?? 0) / 100, or = p._sum.orders7d ?? 0
  if (im === 0) continue
  console.log(`${pad(p.placement, 26)} ${pad(p.marketplace, 4)} ${pad(int(im), 11)} ${pad(int(cl), 8)} ${pad(`€${sp.toFixed(2)}`, 10)} ${pad(`€${sa.toFixed(2)}`, 11)} ${pad(sp > 0 ? (sa / sp).toFixed(2) : '—', 6)} ${pad(cl > 0 ? `€${(sp / cl).toFixed(2)}` : '—', 8)} ${cl > 0 ? `${((or / cl) * 100).toFixed(1)}%` : '—'}`)
}

// ── 4. top-of-search impression share — the headroom ──────────────────────────
const tos = await prisma.amazonAdsPlacementReport.findMany({
  where: { date: { gte: since }, topOfSearchIS: { not: null } },
  select: { campaignId: true, topOfSearchIS: true, impressions: true, date: true },
})
if (tos.length) {
  const byCamp = new Map<string, { s: number; n: number }>()
  for (const r of tos) {
    const e = byCamp.get(r.campaignId) ?? { s: 0, n: 0 }
    e.s += Number(r.topOfSearchIS); e.n++
    byCamp.set(r.campaignId, e)
  }
  const avgs = [...byCamp.values()].map((e) => e.s / e.n).sort((a, b) => a - b)
  const at = (p: number) => avgs[Math.min(avgs.length - 1, Math.floor(avgs.length * p))] ?? 0
  console.log(`\n── top-of-search impression share, per campaign (${byCamp.size} campaigns, ${tos.length} campaign-days) ──`)
  console.log(`  p10 ${(at(0.1) * 100).toFixed(1)}%  ·  median ${(at(0.5) * 100).toFixed(1)}%  ·  p90 ${(at(0.9) * 100).toFixed(1)}%`)
  console.log(`  campaigns averaging <20% of the first row: ${avgs.filter((a) => a < 0.2).length} of ${avgs.length}`)
}

// ── 5. who is allowed to move the lever, and has anyone ───────────────────────
const engines = await prisma.cronRun.groupBy({
  by: ['jobName'],
  where: { jobName: { in: ['top-of-search-defense', 'ad-rank-defend', 'ads-tos-defense'] } },
  _count: { _all: true }, _max: { startedAt: true },
})
console.log(`\n── the engines that write this lever ──`)
for (const name of ['top-of-search-defense', 'ad-rank-defend']) {
  const e = engines.find((x) => x.jobName === name)
  console.log(`  ${pad(name, 26)} ${e ? `runs=${int(e._count._all)} last=${e._max.startedAt?.toISOString().slice(0, 16)}` : 'NEVER RUN'}`)
}
const placementWrites = await prisma.advertisingActionLog.count({
  where: { createdAt: { gte: since }, actionType: { contains: 'placement', mode: 'insensitive' } },
}).catch(() => -1)
console.log(`  AdvertisingActionLog rows mentioning placement, 60d: ${placementWrites === -1 ? 'query failed' : int(placementWrites)}`)

await prisma.$disconnect()
