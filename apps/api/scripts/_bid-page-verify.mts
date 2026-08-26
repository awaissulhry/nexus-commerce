/**
 * BID page — independent verification of BID.S2's published numbers.
 *
 * READ-ONLY. Deliberately does NOT import bid/bidState.ts: re-deriving with their own resolver
 * would only prove it is deterministic. Every figure below is computed from scratch.
 *
 * Claims under test (docs/2026-08-12-bid-s2-columns.md, measured 13:18 Rome 2026-08-12):
 *   at-floor 151 · out-of-band 56 · unrecorded 146 · unnamed 195 (256 all statuses) · no-data 2,421
 *   bidder over 86 ENABLED campaigns: schedule 33 · goal 0 · manual 12 · none 41
 *   placement: 172 of 220 campaigns · 68 of 86 ENABLED · largest +400%
 *   2,442 of 2,540 never-written targets had updatedAt move within 2h
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const ok = (claim: number, got: number) => (claim === got ? '✅' : `❌ claimed ${int(claim)}`)
const now = new Date()
console.log(`\n═══ verifying BID.S2 — ${now.toISOString()} (${new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(now)} Rome) ═══\n`)

// ── the population ───────────────────────────────────────────────────────────
const targets = await prisma.adTarget.findMany({
  where: { isNegative: false, status: 'ENABLED' },
  select: {
    id: true, kind: true, expressionValue: true, bidCents: true, status: true, updatedAt: true,
    suppressedFromBidCents: true,
    adGroup: { select: { campaign: { select: { id: true, name: true, status: true, minBidCents: true, maxBidCents: true, bidsSuppressedAt: true, dynamicBidding: true } } } },
  },
})
const allStatus = await prisma.adTarget.count({ where: { isNegative: false } })
console.log(`ENABLED positive targets: ${int(targets.length)}   (all statuses: ${int(allStatus)})`)

// ── at-floor · out-of-band · unnamed ─────────────────────────────────────────
const atFloor = targets.filter((t) => t.bidCents <= 2 && t.suppressedFromBidCents == null && t.adGroup?.campaign?.bidsSuppressedAt == null)
const outOfBand = targets.filter((t) => { const m = t.adGroup?.campaign?.maxBidCents; return m != null && t.bidCents > m })
const belowFloor = targets.filter((t) => { const m = t.adGroup?.campaign?.minBidCents; return m != null && t.bidCents < m })
const unnamedEnabled = targets.filter((t) => !t.expressionValue || !t.expressionValue.trim())
const unnamedAll = await prisma.adTarget.count({ where: { isNegative: false, OR: [{ expressionValue: '' }] } })
const suppressed = targets.filter((t) => t.suppressedFromBidCents != null)
const inWindow = targets.filter((t) => t.adGroup?.campaign?.bidsSuppressedAt != null)

console.log(`\n── chip populations, re-derived ──`)
console.log(`  at-floor (≤2¢, no memory, no window) : ${String(int(atFloor.length)).padStart(6)}  ${ok(151, atFloor.length)}`)
console.log(`  out-of-band (bid > maxBidCents)      : ${String(int(outOfBand.length)).padStart(6)}  ${ok(56, outOfBand.length)}`)
console.log(`  below-floor (bid < minBidCents)      : ${String(int(belowFloor.length)).padStart(6)}  ${ok(0, belowFloor.length)}  ← 0 campaigns declare a floor`)
console.log(`  unnamed, ENABLED                     : ${String(int(unnamedEnabled.length)).padStart(6)}  ${ok(195, unnamedEnabled.length)}`)
console.log(`  unnamed, all statuses                : ${String(int(unnamedAll)).padStart(6)}  ${ok(256, unnamedAll)}`)
console.log(`  suppressed (has restore value)       : ${String(int(suppressed.length)).padStart(6)}  ⏰ clock-dependent`)
console.log(`  min-bid-window (campaign flagged)    : ${String(int(inWindow.length)).padStart(6)}  ⏰ clock-dependent`)
const notInAuction = targets.filter((t) => t.adGroup?.campaign?.status !== 'ENABLED')
console.log(`  not-in-auction                       : ${String(int(notInAuction.length)).padStart(6)}  ${ok(1853, notInAuction.length)}`)

// ── no-data ──────────────────────────────────────────────────────────────────
const since30 = new Date(Date.now() - 30 * 86_400_000)
const perf = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'],
  where: { entityType: 'AD_TARGET', date: { gte: since30 }, localEntityId: { in: targets.map((t) => t.id) } },
  _sum: { impressions: true, clicks: true, costMicros: true },
})
const withAnyRow = new Set(perf.map((p) => p.localEntityId!))
const withImpr = new Set(perf.filter((p) => Number(p._sum.impressions ?? 0) > 0).map((p) => p.localEntityId!))
console.log(`\n  targets with ANY 30d perf row        : ${String(int(withAnyRow.size)).padStart(6)}`)
console.log(`  targets with >0 impressions, 30d     : ${String(int(withImpr.size)).padStart(6)}`)
console.log(`  no-data (no impressions in 30d)      : ${String(int(targets.length - withImpr.size)).padStart(6)}  ${ok(2421, targets.length - withImpr.size)}`)

// ── unrecorded: bidCents != the newValue of the last audited bid change ──────
const hist = await prisma.$queryRaw<Array<{ entityId: string; newValue: string | null; changedAt: Date }>>`
  SELECT DISTINCT ON ("entityId") "entityId", "newValue", "changedAt"
  FROM "CampaignBidHistory"
  WHERE "entityType" = 'AD_TARGET' AND "field" IN ('bid','defaultBid')
  ORDER BY "entityId", "changedAt" DESC`
const lastAudited = new Map(hist.map((h) => [h.entityId, { v: Number(h.newValue), at: h.changedAt }]))
const audited = targets.filter((t) => lastAudited.has(t.id))
const unrecorded = audited.filter((t) => Number.isFinite(lastAudited.get(t.id)!.v) && lastAudited.get(t.id)!.v !== t.bidCents)
console.log(`\n  targets with ANY audited bid change  : ${String(int(audited.length)).padStart(6)}`)
console.log(`  unrecorded (current ≠ last audited)  : ${String(int(unrecorded.length)).padStart(6)}  ${ok(146, unrecorded.length)}  ⏰ clock-dependent`)
const restoredFromFloor = unrecorded.filter((t) => lastAudited.get(t.id)!.v <= 2)
console.log(`    …whose last audited value was ≤2¢  : ${String(int(restoredFromFloor.length)).padStart(6)}  (claim: 126 were a floor to €0.02)`)

// ── the updatedAt heartbeat hypothesis ───────────────────────────────────────
const since60 = new Date(Date.now() - 60 * 86_400_000)
const written = new Set((await prisma.campaignBidHistory.findMany({
  where: { entityType: 'AD_TARGET', field: { in: ['bid', 'defaultBid'] }, changedAt: { gte: since60 } },
  select: { entityId: true }, distinct: ['entityId'],
})).map((r) => r.entityId))
const neverWritten = targets.filter((t) => !written.has(t.id))
const movedIn2h = neverWritten.filter((t) => +now - +t.updatedAt < 2 * 3_600_000)
console.log(`\n── the updatedAt heartbeat ──`)
console.log(`  targets with NO bid write in 60d     : ${String(int(neverWritten.length)).padStart(6)}  (claim: 2,540)`)
console.log(`  …whose updatedAt moved within 2h     : ${String(int(movedIn2h.length)).padStart(6)}  (claim: 2,442)`)
console.log(`  ← if this is most of them, updatedAt is a sync heartbeat and cannot detect a change.`)

// ── the bidder split ─────────────────────────────────────────────────────────
const camps = await prisma.campaign.findMany({ select: { id: true, name: true, status: true, dynamicBidding: true } })
const enabled = camps.filter((c) => c.status === 'ENABLED')
const schedCamps = new Set((await prisma.adSchedule.findMany({ where: { enabled: true }, select: { campaignId: true } })).map((s) => s.campaignId))
const logs = await prisma.advertisingActionLog.findMany({
  where: { createdAt: { gte: since60 }, actionType: 'AD_BID_UPDATE' },
  select: { userId: true, entityId: true, entityType: true },
})
const tIds = [...new Set(logs.filter((l) => l.entityType === 'AD_TARGET').map((l) => l.entityId))]
const gIds = [...new Set(logs.filter((l) => l.entityType === 'AD_GROUP').map((l) => l.entityId))]
const [tr, gr] = await Promise.all([
  prisma.adTarget.findMany({ where: { id: { in: tIds } }, select: { id: true, adGroup: { select: { campaignId: true } } } }),
  prisma.adGroup.findMany({ where: { id: { in: gIds } }, select: { id: true, campaignId: true } }),
])
const campOf = new Map<string, string>()
for (const t of tr) if (t.adGroup?.campaignId) campOf.set(t.id, t.adGroup.campaignId)
for (const g of gr) campOf.set(g.id, g.campaignId)
const manualCamps = new Set<string>()
for (const l of logs) {
  const a = String(l.userId ?? '')
  if (a.startsWith('automation:') || a === 'system' || !a) continue
  const cid = campOf.get(l.entityId); if (cid) manualCamps.add(cid)
}
const dyn = (c: { dynamicBidding: unknown }) => (c.dynamicBidding ?? {}) as { targetAcos?: number; placementBidding?: Array<{ placement: string; percentage: number }> }
let sched = 0, goal = 0, manual = 0, none = 0
for (const c of enabled) {
  if (schedCamps.has(c.id)) sched++
  else if (dyn(c).targetAcos != null) goal++
  else if (manualCamps.has(c.id)) manual++
  else none++
}
console.log(`\n── bidder, over ${int(enabled.length)} ENABLED campaigns ──`)
console.log(`  schedule ${sched} ${ok(33, sched)} · goal ${goal} ${ok(0, goal)} · manual ${manual} ${ok(12, manual)} · none ${none} ${ok(41, none)}`)

// ── placement — the number that conflicts with the PLC study ─────────────────
const withAnyEntry = camps.filter((c) => (dyn(c).placementBidding ?? []).length > 0)
const withNonZero = camps.filter((c) => (dyn(c).placementBidding ?? []).some((p) => Number(p.percentage) > 0))
const enWithNonZero = enabled.filter((c) => (dyn(c).placementBidding ?? []).some((p) => Number(p.percentage) > 0))
let maxPct = 0, maxWho = '', maxLane = ''
const byLane = new Map<string, { n: number; max: number }>()
for (const c of camps) for (const p of dyn(c).placementBidding ?? []) {
  const v = Number(p.percentage) || 0
  if (v > 0) { const e = byLane.get(p.placement) ?? { n: 0, max: 0 }; e.n++; e.max = Math.max(e.max, v); byLane.set(p.placement, e) }
  if (v > maxPct) { maxPct = v; maxWho = c.name; maxLane = p.placement }
}
console.log(`\n── placement multipliers, ${int(camps.length)} campaigns ──`)
console.log(`  campaigns with ANY placementBidding entry : ${String(int(withAnyEntry.length)).padStart(4)}  ${ok(172, withAnyEntry.length)}`)
console.log(`  campaigns with a NON-ZERO multiplier      : ${String(int(withNonZero.length)).padStart(4)}  (PLC study said 145)`)
console.log(`  ENABLED with a non-zero multiplier        : ${String(int(enWithNonZero.length)).padStart(4)}  ${ok(68, enWithNonZero.length)}`)
console.log(`  largest multiplier anywhere              : +${maxPct}%  ${ok(400, maxPct)}  on ${maxWho} [${maxLane}]`)
for (const [k, v] of [...byLane].sort((a, b) => b[1].n - a[1].n)) console.log(`    ${pad(k, 28)} ${String(v.n).padStart(4)} campaigns · max +${v.max}%`)

// ── did the audited floor/restore asymmetry hold? ────────────────────────────
const reasons = await prisma.campaignBidHistory.groupBy({
  by: ['reason'], where: { changedAt: { gte: new Date(Date.now() - 86_400_000) }, field: { in: ['bid', 'defaultBid'] } },
  _count: { _all: true },
})
console.log(`\n── last 24h of audited bid changes, by reason (the floor/restore asymmetry) ──`)
for (const r of reasons.sort((a, b) => b._count._all - a._count._all).slice(0, 8)) console.log(`  ${String(int(r._count._all)).padStart(6)}  ${(r.reason ?? '(null)').slice(0, 72)}`)

await prisma.$disconnect()
