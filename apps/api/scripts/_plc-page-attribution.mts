/**
 * PLC page study, pass 2 — READ-ONLY. No writes, no mutations.
 *
 *  I.   The 9,207 unattributed placement writes — who, when, which campaigns.
 *  II.  The 15,366 audit rows vs 11,652 history rows gap.
 *  III. Per-campaign inversion: highest multiplier vs that campaign's own lane returns.
 *  IV.  What the 33 live schedules are actually holding (lastApplied / target).
 *  V.   The tab's rules — executions, and whether defend_top_of_search ever fired.
 *  VI.  Churn: how much of the write volume changes nothing.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : 'never')
const eur = (c: number) => `€${(c / 100).toFixed(2)}`
const H = (t: string) => console.log(`\n${'─'.repeat(78)}\n${t}\n${'─'.repeat(78)}`)

const TOP = 'PLACEMENT_TOP', REST = 'PLACEMENT_REST_OF_SEARCH', PROD = 'PLACEMENT_PRODUCT_PAGE'
const LANES = [TOP, REST, PROD]
const SHORT: Record<string, string> = { [TOP]: 'Top', [REST]: 'Rest', [PROD]: 'Product' }
const REPORT_TO_LANE: Record<string, string> = {
  'Top of Search on-Amazon': TOP, 'Other on-Amazon': REST, 'Detail Page on-Amazon': PROD,
}
const since60 = new Date(Date.now() - 60 * 86_400_000)

console.log('\n═══ PLC page pass 2 — attribution, inversion, what is actually held ═══\n')

// ─────────────────────────────────────────────────────────────────────────────
H('I · The unattributed placement writes')

const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'update_placement_bidding', createdAt: { gte: since60 } },
  select: { userId: true, entityId: true, createdAt: true, payloadAfter: true, amazonResponseStatus: true },
})
const anon = logs.filter((l) => !l.userId || l.userId === 'system')
const named = logs.filter((l) => l.userId && l.userId !== 'system')
console.log(`total 60d: ${int(logs.length)} · attributed ${int(named.length)} · UNATTRIBUTED ${int(anon.length)} (${((anon.length / logs.length) * 100).toFixed(0)}%)`)

const byDayAnon = new Map<string, number>(), byDayNamed = new Map<string, number>()
for (const l of anon) byDayAnon.set(day(l.createdAt), (byDayAnon.get(day(l.createdAt)) ?? 0) + 1)
for (const l of named) byDayNamed.set(day(l.createdAt), (byDayNamed.get(day(l.createdAt)) ?? 0) + 1)
const allDays = [...new Set([...byDayAnon.keys(), ...byDayNamed.keys()])].sort()
console.log(`\n${pad('day', 12)} ${pad('attributed', 12)} unattributed`)
for (const d of allDays) console.log(`${pad(d, 12)} ${pad(int(byDayNamed.get(d) ?? 0), 12)} ${int(byDayAnon.get(d) ?? 0)}`)

console.log(`\nunattributed touched ${new Set(anon.map((l) => l.entityId)).size} campaigns; attributed touched ${new Set(named.map((l) => l.entityId)).size}`)
const actors = new Map<string, number>()
for (const l of named) {
  const a = String(l.userId)
  const k = a.startsWith('automation:rank-defend') ? 'automation:rank-defend-*'
    : a.startsWith('automation:rank-plan') ? 'automation:rank-plan-*'
      : a.startsWith('automation:') ? a : 'user/other'
  actors.set(k, (actors.get(k) ?? 0) + 1)
}
console.log('attributed by actor:')
for (const [k, v] of [...actors].sort((a, b) => b[1] - a[1])) console.log(`  ${pad(k, 30)} ${int(v)}`)

// are the unattributed ones OLD (pre-fix) or ONGOING?
const last7 = new Date(Date.now() - 7 * 86_400_000)
console.log(`\nunattributed in the LAST 7 DAYS: ${int(anon.filter((l) => l.createdAt >= last7).length)}   ← ongoing, or legacy?`)
const anonCamps = new Map<string, number>()
for (const l of anon) anonCamps.set(l.entityId ?? '?', (anonCamps.get(l.entityId ?? '?') ?? 0) + 1)
const campNames = new Map((await prisma.campaign.findMany({ select: { id: true, name: true, marketplace: true } })).map((c) => [c.id, `${c.name} (${c.marketplace ?? '—'})`]))
console.log('top unattributed-write campaigns:')
for (const [id, n] of [...anonCamps].sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${pad(campNames.get(id) ?? id, 50)} ${int(n)}`)

// ─────────────────────────────────────────────────────────────────────────────
H('II · Audit rows vs history rows — the writes that changed nothing')

const hist = await prisma.campaignBidHistory.findMany({
  where: { field: { in: LANES }, changedAt: { gte: since60 } },
  select: { campaignId: true, field: true, oldValue: true, newValue: true, changedAt: true, changedBy: true },
})
console.log(`audit rows (one per WRITE):        ${int(logs.length)}`)
console.log(`history rows (one per CHANGED lane): ${int(hist.length)}`)
const histCamps = new Set(hist.map((h) => h.campaignId))
const logCamps = new Set(logs.map((l) => l.entityId))
console.log(`campaigns in audit: ${logCamps.size} · in history: ${histCamps.size} · in audit but NEVER in history: ${[...logCamps].filter((c) => !histCamps.has(c)).length}`)
console.log('  (a campaign in the audit log but never in history received placement writes that changed no lane value)')
for (const id of [...logCamps].filter((c) => !histCamps.has(c)).slice(0, 8)) console.log(`    ${campNames.get(id) ?? id}`)

let absentToZero = 0, realMove = 0
for (const h of hist) {
  if (h.oldValue == null && Number(h.newValue) === 0) absentToZero++
  else realMove++
}
console.log(`\nhistory rows that wrote 0 over an ABSENT lane (no observable change): ${int(absentToZero)} (${((absentToZero / hist.length) * 100).toFixed(0)}%)`)
console.log(`history rows recording a real value move:                            ${int(realMove)}`)

// ─────────────────────────────────────────────────────────────────────────────
H('III · Inversion, per campaign — is the biggest multiplier on the worst lane?')

const camps = await prisma.campaign.findMany({
  select: { id: true, name: true, marketplace: true, status: true, dynamicBidding: true, externalCampaignId: true, liveBidWritesEnabled: true },
})
interface PB { placement: string; percentage: number }
const laneOf = (c: (typeof camps)[number], l: string) => {
  const db = (c.dynamicBidding ?? {}) as { placementBidding?: PB[] }
  return (Array.isArray(db.placementBidding) ? db.placementBidding : []).find((x) => x.placement === l)?.percentage ?? 0
}
const perf = await prisma.amazonAdsPlacementReport.groupBy({
  by: ['campaignId', 'placement'],
  where: { date: { gte: since60 } },
  _sum: { impressions: true, clicks: true, costMicros: true, sales7dCents: true, orders7d: true },
})
const byCampLane = new Map<string, { impr: number; clicks: number; spend: number; sales: number; orders: number }>()
for (const p of perf) {
  const lane = REPORT_TO_LANE[p.placement]
  if (!lane) continue
  byCampLane.set(`${p.campaignId}|${lane}`, {
    impr: p._sum.impressions ?? 0, clicks: p._sum.clicks ?? 0,
    spend: Math.round(Number(p._sum.costMicros ?? 0n) / 10000),
    sales: p._sum.sales7dCents ?? 0, orders: p._sum.orders7d ?? 0,
  })
}
const MIN_CLICKS = 20 // a lane needs real traffic before its ROAS decides anything
let evaluated = 0, inverted = 0
const invertedRows: string[] = []
for (const c of camps) {
  if (!c.externalCampaignId) continue
  const lanes = LANES.map((l) => {
    const s = byCampLane.get(`${c.externalCampaignId}|${l}`)
    return { lane: l, pct: laneOf(c, l), spend: s?.spend ?? 0, sales: s?.sales ?? 0, clicks: s?.clicks ?? 0, roas: s && s.spend > 0 ? s.sales / s.spend : null }
  })
  const scored = lanes.filter((l) => l.clicks >= MIN_CLICKS && l.roas != null)
  if (scored.length < 2) continue
  const maxPct = Math.max(...lanes.map((l) => l.pct))
  if (maxPct === 0) continue
  evaluated++
  const topPaid = scored.slice().sort((a, b) => b.pct - a.pct)[0]
  const bestRoas = scored.slice().sort((a, b) => (b.roas ?? 0) - (a.roas ?? 0))[0]
  if (topPaid.lane !== bestRoas.lane && (topPaid.roas ?? 0) < (bestRoas.roas ?? 0)) {
    inverted++
    invertedRows.push(
      `${pad(c.name, 38)} ${pad(c.marketplace ?? '—', 4)} paying most into ${pad(SHORT[topPaid.lane], 8)} ${pad(`${topPaid.pct}%`, 6)} ROAS ${pad((topPaid.roas ?? 0).toFixed(2), 6)} | best lane ${pad(SHORT[bestRoas.lane], 8)} ${pad(`${bestRoas.pct}%`, 6)} ROAS ${(bestRoas.roas ?? 0).toFixed(2)}`,
    )
  }
}
console.log(`campaigns with >=2 lanes at >=${MIN_CLICKS} clicks and a non-zero multiplier: ${evaluated}`)
console.log(`…of which the highest multiplier sits on a WORSE-returning lane:           ${inverted}`)
for (const r of invertedRows.slice(0, 20)) console.log(`  ${r}`)

// ─────────────────────────────────────────────────────────────────────────────
H('IV · What the 33 live schedules are actually holding right now')

const scheds = await prisma.adSchedule.findMany({
  where: { enabled: true },
  select: { id: true, name: true, campaignId: true, defaultTargetKey: true, lastApplied: true, lastEvaluatedAt: true, windows: true },
})
const held = new Map<string, number>()
for (const s of scheds) held.set(String(s.lastApplied ?? 'null'), (held.get(String(s.lastApplied ?? 'null')) ?? 0) + 1)
console.log(`enabled schedules: ${scheds.length}`)
console.log(`lastApplied (the target the engine last resolved): ${[...held].map(([k, v]) => `${k}=${v}`).join(' · ')}`)
const evals = scheds.map((s) => s.lastEvaluatedAt).filter(Boolean) as Date[]
console.log(`most recent evaluation: ${evals.length ? new Date(Math.max(...evals.map((d) => +d))).toISOString() : 'never'}`)
const baselines = new Map<string, number>()
for (const s of scheds) baselines.set(String(s.defaultTargetKey ?? 'null'), (baselines.get(String(s.defaultTargetKey ?? 'null')) ?? 0) + 1)
console.log(`baseline target: ${[...baselines].map(([k, v]) => `${k}=${v}`).join(' · ')}`)
const wkeys = new Map<string, number>()
for (const s of scheds) for (const w of (Array.isArray(s.windows) ? s.windows : []) as Array<{ targetKey?: string }>) {
  if (w?.targetKey) wkeys.set(w.targetKey, (wkeys.get(w.targetKey) ?? 0) + 1)
}
console.log(`window targetKeys across live schedules: ${[...wkeys].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · ')}`)

// ─────────────────────────────────────────────────────────────────────────────
H('V · The tab\'s rules — and did defend_top_of_search ever fire?')

const rules = await prisma.automationRule.findMany({
  where: { domain: 'advertising' },
  select: { id: true, name: true, enabled: true, autonomyLevel: true, trigger: true, actions: true, executionCount: true, lastExecutedAt: true },
})
const types = (a: unknown) => (Array.isArray(a) ? a : []).map((x) => String((x as { type?: unknown })?.type ?? ''))
const PLACEMENT_ACTIONS = ['set_placement_multiplier', 'defend_top_of_search']
const onTab = rules.filter((r) => types(r.actions).some((t) => PLACEMENT_ACTIONS.includes(t)))
console.log(`rules the tab lists: ${onTab.length}`)
let setPm = 0, defendTos = 0
for (const r of onTab) for (const t of types(r.actions)) {
  if (t === 'set_placement_multiplier') setPm++
  if (t === 'defend_top_of_search') defendTos++
}
console.log(`action instances across those rules: set_placement_multiplier=${setPm} · defend_top_of_search=${defendTos}`)
console.log(`${pad('rule', 46)} ${pad('on', 4)} ${pad('level', 8)} ${pad('execs', 7)} last`)
for (const r of onTab.sort((a, b) => b.executionCount - a.executionCount)) {
  console.log(`${pad(r.name, 46)} ${pad(r.enabled ? 'YES' : 'no', 4)} ${pad(String(r.autonomyLevel), 8)} ${pad(int(r.executionCount), 7)} ${day(r.lastExecutedAt)}`)
}

// did ANY execution actually produce a placement write?
const execs = await prisma.automationRuleExecution.count({ where: { ruleId: { in: onTab.map((r) => r.id) } } }).catch(() => -1)
console.log(`\nAutomationRuleExecution rows for those rules: ${execs === -1 ? 'QUERY FAILED (not a zero)' : int(execs)}`)
const execOk = await prisma.automationRuleExecution.groupBy({ by: ['status'], where: { ruleId: { in: onTab.map((r) => r.id) } }, _count: { _all: true } }).catch(() => null)
console.log(`  by status: ${execOk ? execOk.map((e) => `${e.status}=${int(e._count._all)}`).join(' · ') : 'QUERY FAILED (not a zero)'}`)
const tosActor = await prisma.campaignBidHistory.count({ where: { field: { in: LANES }, changedBy: { contains: 'tos-optimizer' } } })
console.log(`placement history rows written by automation:tos-optimizer (all time): ${int(tosActor)}`)
const cronRuns = await prisma.cronRun.groupBy({
  by: ['jobName'], where: { jobName: { in: ['ad-rank-defend', 'top-of-search-defense', 'ad-dayparting'] } },
  _count: { _all: true }, _max: { startedAt: true },
}).catch(() => null)
if (cronRuns) for (const c of cronRuns) console.log(`cron ${pad(c.jobName, 24)} runs=${pad(int(c._count._all), 8)} last=${c._max.startedAt?.toISOString() ?? 'never'}`)
else console.log('cronRun query failed — NOT a zero')

// ─────────────────────────────────────────────────────────────────────────────
H('VI · Account-wide lane economics, 60d (the grid\'s denominator)')

const laneTot = new Map<string, { impr: number; clicks: number; spend: number; sales: number; orders: number }>()
for (const p of perf) {
  const lane = REPORT_TO_LANE[p.placement]; if (!lane) continue
  const t = laneTot.get(lane) ?? { impr: 0, clicks: 0, spend: 0, sales: 0, orders: 0 }
  t.impr += p._sum.impressions ?? 0; t.clicks += p._sum.clicks ?? 0
  t.spend += Math.round(Number(p._sum.costMicros ?? 0n) / 10000)
  t.sales += p._sum.sales7dCents ?? 0; t.orders += p._sum.orders7d ?? 0
  laneTot.set(lane, t)
}
const totSpend = [...laneTot.values()].reduce((s, t) => s + t.spend, 0)
const totImpr = [...laneTot.values()].reduce((s, t) => s + t.impr, 0)
console.log(`${pad('lane', 10)} ${pad('impressions', 13)} ${pad('%impr', 7)} ${pad('spend', 11)} ${pad('%spend', 7)} ${pad('sales', 11)} ${pad('ROAS', 6)} ${pad('CPC', 7)} CVR`)
for (const l of LANES) {
  const t = laneTot.get(l); if (!t) continue
  console.log(`${pad(SHORT[l], 10)} ${pad(int(t.impr), 13)} ${pad(`${((t.impr / totImpr) * 100).toFixed(1)}%`, 7)} ${pad(eur(t.spend), 11)} ${pad(`${((t.spend / totSpend) * 100).toFixed(1)}%`, 7)} ${pad(eur(t.sales), 11)} ${pad((t.sales / t.spend).toFixed(2), 6)} ${pad(eur(Math.round(t.spend / Math.max(1, t.clicks))), 7)} ${((t.orders / Math.max(1, t.clicks)) * 100).toFixed(1)}%`)
}

await prisma.$disconnect()
console.log('\n═══ done — read-only ═══\n')
