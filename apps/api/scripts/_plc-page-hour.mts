/**
 * PLC.0 — why does "carrying a multiplier" read 145 now and 167 in the study?
 *
 * READ-ONLY. Hypothesis: the 33 schedule-governed campaigns hold `pause` (biasPct 0) at this hour,
 * so their lanes are genuinely 0 right now and were 150% when the study ran at ~13:00. If so,
 * "carrying" is a TIME-OF-DAY-DEPENDENT number for the governed set, and 167 vs 145 is not a
 * disagreement about the code — it is the same code reading a different hour.
 *
 * Run from apps/api:
 *   NEXUS_AMAZON_ADS_QUOTA_MODE=off railway run npx tsx scripts/_plc-page-hour.mts
 */
import '../src/env.js'

const { default: prisma } = await import('../src/db.js')
const { laneMultipliers, PLC_LANES, KEY_BY_LANE, resolveOwnership } = await import('../src/services/advertising/placement-grid.service.js')

const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const H = (t: string) => console.log(`\n${'─'.repeat(80)}\n${t}\n${'─'.repeat(80)}`)

const nowRome = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Rome', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date())
console.log(`\n═══ PLC.0 — the hour, and what the governed set is holding ═══`)
console.log(`UTC ${new Date().toISOString()}   Europe/Rome ${nowRome}`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('A · What are the 33 live goal-mode schedules holding right now?')

const scheds = await prisma.adSchedule.findMany({
  where: { enabled: true },
  select: { id: true, campaignId: true, name: true, lastApplied: true, lastEvaluatedAt: true, defaultTargetKey: true, windows: true },
})
const { isGoalMode } = await import('../src/jobs/ad-rank-defend.job.js')
const goal = scheds.filter((s) => isGoalMode(s.windows, s.defaultTargetKey))
const held = new Map<string, number>()
for (const s of goal) held.set(String(s.lastApplied ?? '(null)'), (held.get(String(s.lastApplied ?? '(null)')) ?? 0) + 1)
console.log(`  enabled goal-mode schedules: ${goal.length}`)
console.log(`  lastApplied: ${[...held].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
const newest = goal.map((s) => s.lastEvaluatedAt).filter((d): d is Date => !!d).sort((a, b) => +b - +a)[0]
console.log(`  newest lastEvaluatedAt: ${newest ? newest.toISOString() : 'never'}`)

const targets = await prisma.rankTarget.findMany({ select: { key: true, placement: true, biasPct: true, maxBiasPct: true, allOut: true } })
console.log('\n  the goal library (biasPct is the FLOOR the engine pins to):')
for (const t of targets) console.log(`    ${pad(t.key, 18)} ${pad(t.placement, 26)} bias=${pad(String(t.biasPct ?? '—'), 5)} maxBias=${pad(String(t.maxBiasPct ?? 'null'), 6)} allOut=${t.allOut}`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('B · The governed campaigns — are their lanes 0 right now?')

const ownership = await resolveOwnership()
const governedIds = [...ownership.byCampaign.keys()]
const camps = await prisma.campaign.findMany({
  where: { id: { in: governedIds } },
  select: { id: true, name: true, marketplace: true, status: true, dynamicBidding: true },
  orderBy: { name: 'asc' },
})
let zeroAll = 0
console.log(`  ${pad('campaign', 34)} ${pad('mkt', 4)} ${PLC_LANES.map((l) => pad(KEY_BY_LANE[l], 9)).join('')}`)
for (const c of camps) {
  const m = laneMultipliers(c.dynamicBidding)
  const any = PLC_LANES.some((l) => m[l] > 0)
  if (!any) zeroAll += 1
  console.log(`  ${pad(c.name, 34)} ${pad(c.marketplace ?? '—', 4)} ${PLC_LANES.map((l) => pad(`${m[l]}%`, 9)).join('')}${any ? '' : '   ← all zero'}`)
}
console.log(`\n  governed campaigns: ${camps.length} · carrying nothing right now: ${zeroAll} · carrying something: ${camps.length - zeroAll}`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('C · Did those lanes get written to 0 recently? (CampaignBidHistory, last 24h)')

const since = new Date(Date.now() - 24 * 3600_000)
const hist = await prisma.campaignBidHistory.findMany({
  where: { field: { in: [...PLC_LANES] }, changedAt: { gte: since }, campaignId: { in: governedIds } },
  select: { campaignId: true, field: true, oldValue: true, newValue: true, changedAt: true, changedBy: true, reason: true },
  orderBy: { changedAt: 'desc' },
  take: 400,
})
console.log(`  placement history rows on governed campaigns, 24h: ${hist.length}`)
const toZero = hist.filter((h) => Number(h.newValue ?? 0) === 0 && Number(h.oldValue ?? 0) > 0)
console.log(`  …of which wrote a NON-ZERO lane down to 0: ${toZero.length}`)
for (const h of toZero.slice(0, 12)) {
  const c = camps.find((x) => x.id === h.campaignId)
  console.log(`    ${h.changedAt.toISOString()} ${pad(c?.name ?? h.campaignId, 30)} ${pad(KEY_BY_LANE[h.field as (typeof PLC_LANES)[number]] ?? h.field, 8)} ${h.oldValue}→${h.newValue}  ${(h.reason ?? '').slice(0, 46)}`)
}
const hours = new Map<number, number>()
for (const h of hist) {
  const romeHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }).format(h.changedAt))
  hours.set(romeHour, (hours.get(romeHour) ?? 0) + 1)
}
console.log(`\n  writes by Rome hour, last 24h: ${[...hours].sort((a, b) => a[0] - b[0]).map(([h, n]) => `${String(h).padStart(2, '0')}:${n}`).join(' ')}`)

// ─────────────────────────────────────────────────────────────────────────────────────────────
H('D · Peak carrying — what WOULD the count be if the governed set were at its floor?')

const floorByKey = new Map(targets.map((t) => [t.key, t.biasPct ?? 0]))
let wouldCarry = 0
for (const c of camps) {
  const s = goal.find((g) => g.campaignId === c.id)
  const key = s?.lastApplied ?? s?.defaultTargetKey ?? null
  const m = laneMultipliers(c.dynamicBidding)
  const any = PLC_LANES.some((l) => m[l] > 0)
  // A governed campaign whose target has a non-zero floor WILL carry a multiplier during the
  // hours that target governs, whatever it reads at this instant.
  const everCarries = any || [...floorByKey.values()].some((v) => v > 0)
  if (everCarries) wouldCarry += 1
  void key
}
const allCamps = await prisma.campaign.findMany({ select: { id: true, dynamicBidding: true } })
const carryingNow = allCamps.filter((c) => { const m = laneMultipliers(c.dynamicBidding); return PLC_LANES.some((l) => m[l] > 0) }).length
console.log(`  campaigns carrying a multiplier RIGHT NOW:                     ${carryingNow}`)
console.log(`  governed campaigns carrying nothing right now:                 ${zeroAll}`)
console.log(`  carrying now + governed-at-zero (the study's ~13:00 reading):  ${carryingNow + zeroAll}`)
void wouldCarry

await prisma.$disconnect()
console.log('\n═══ done — read-only ═══\n')
