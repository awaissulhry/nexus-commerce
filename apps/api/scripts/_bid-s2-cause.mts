/**
 * BID.S2 — the two answers the first two probes got wrong. READ-ONLY.
 *
 * 🔴 Probe 1 §7 asked for `placementBidsJson` and `cpcCapPct` — neither exists — behind a
 * `.catch(() => [])`, and reported "0". Probe 2 then looked in `bidStrategyJson.adjustments[]`
 * and reported "0" honestly, but that is also the wrong place: `placement-grid.service.ts:254`
 * reads **`Campaign.dynamicBidding.placementBidding[]`**. Third time, against the field the
 * shipped Placement page actually uses, and with NO catch swallowing a name error.
 *
 * And: WHY do 147 targets' live bid disagree with their last audited value?
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const c2e = (c: number) => `€${(c / 100).toFixed(2)}`
const now = new Date()
console.log(`\n═══ BID.S2 — the real cause, and the real placement field · ${now.toLocaleString('en-GB', { timeZone: 'Europe/Rome' })} Rome ═══\n`)

// ── A. why does the live bid disagree with the last audited value? ───────────
console.log('A · The 147 drifted targets — what actually happened to them?')
const since60 = new Date(now.getTime() - 60 * 86400_000)
const targets = await prisma.adTarget.findMany({
  where: { isNegative: false, status: 'ENABLED' },
  select: { id: true, bidCents: true, expressionValue: true, lastSyncedAt: true, adGroup: { select: { campaign: { select: { name: true, status: true } } } } },
})
const hist = await prisma.campaignBidHistory.findMany({
  where: { entityType: 'AD_TARGET', field: { in: ['bid', 'defaultBid'] }, changedAt: { gte: since60 } },
  select: { entityId: true, newValue: true, changedAt: true, changedBy: true, reason: true },
  orderBy: { changedAt: 'desc' },
})
const last = new Map<string, { v: number; at: Date; by: string; reason: string | null }>()
for (const h of hist) {
  if (last.has(h.entityId)) continue
  const v = Number(h.newValue)
  if (Number.isFinite(v)) last.set(h.entityId, { v, at: h.changedAt, by: h.changedBy, reason: h.reason })
}
const drifted = targets.filter((t) => { const a = last.get(t.id); return a && a.v !== t.bidCents })
console.log(`     ENABLED targets whose live bid != last audited value: ${int(drifted.length)}`)

// classify: was the last audited write a FLOOR? and did Amazon accept it?
let lastWasFloor = 0, lastWasRaise = 0
for (const t of drifted) { const a = last.get(t.id)!; if (a.v <= 2) lastWasFloor++; else lastWasRaise++ }
console.log(`     …whose LAST audited write was a floor (<=2c): ${int(lastWasFloor)}`)
console.log(`     …whose last audited write was something else : ${int(lastWasRaise)}`)

// did those floors reach Amazon?
const driftIds = drifted.map((t) => t.id)
const logs = await prisma.advertisingActionLog.findMany({
  where: { entityId: { in: driftIds }, actionType: 'AD_BID_UPDATE', createdAt: { gte: since60 } },
  select: { entityId: true, createdAt: true, amazonResponseStatus: true, payloadAfter: true },
  orderBy: { createdAt: 'desc' },
})
const lastLog = new Map<string, { status: string | null; at: Date }>()
for (const l of logs) { if (!lastLog.has(l.entityId)) lastLog.set(l.entityId, { status: l.amazonResponseStatus, at: l.createdAt }) }
const statusTally = new Map<string, number>()
for (const t of drifted) { const s = lastLog.get(t.id)?.status ?? '(no log row)'; statusTally.set(s, (statusTally.get(s) ?? 0) + 1) }
console.log(`     delivery status of their last logged write: ${[...statusTally.entries()].map(([s, n]) => `${s} ${n}`).join(' · ')}`)

// how stale is the last audit vs the last sync?
let syncedAfterAudit = 0
for (const t of drifted) {
  const a = last.get(t.id)!
  if (t.lastSyncedAt && t.lastSyncedAt > a.at) syncedAfterAudit++
}
console.log(`     …whose lastSyncedAt is AFTER the last audited write: ${int(syncedAfterAudit)} of ${int(drifted.length)}`)
console.log('     → if that is ~all of them, the inbound resync overwrote the value and left no row:')
console.log('       the change is real, unaudited, and NOT necessarily a human in Seller Central.')

// campaign status of the drifted — a paused campaign explains a stale floor
const byCampStatus = new Map<string, number>()
for (const t of drifted) { const s = t.adGroup.campaign.status; byCampStatus.set(s, (byCampStatus.get(s) ?? 0) + 1) }
console.log(`     campaign status of drifted targets: ${[...byCampStatus.entries()].map(([s, n]) => `${s} ${n}`).join(' · ')}`)
console.log('\n     sample:')
for (const t of drifted.slice(0, 6)) {
  const a = last.get(t.id)!
  console.log(`        "${(t.expressionValue || '(unnamed)').slice(0, 24).padEnd(24)}" audited ${c2e(a.v).padStart(6)} → live ${c2e(t.bidCents).padStart(6)} · ${a.at.toISOString().slice(0, 16)} · ${(a.reason ?? '').slice(0, 40)}`)
}

// ── B. placement multipliers, from dynamicBidding.placementBidding ───────────
console.log('\nB · Placement multipliers — Campaign.dynamicBidding.placementBidding[]')
const camps = await prisma.campaign.findMany({ select: { id: true, name: true, status: true, dynamicBidding: true } })
interface PB { placement?: string; percentage?: number }
let withAny = 0, enabledWithAny = 0, biggest = 0, biggestName = ''
const laneTally = new Map<string, number>()
const strategyTally = new Map<string, number>()
for (const c of camps) {
  const db = (c.dynamicBidding ?? {}) as { placementBidding?: PB[]; strategy?: string }
  strategyTally.set(String(db.strategy ?? '(none)'), (strategyTally.get(String(db.strategy ?? '(none)')) ?? 0) + 1)
  const list = Array.isArray(db.placementBidding) ? db.placementBidding : []
  const nonZero = list.filter((p) => Number(p?.percentage) > 0)
  if (nonZero.length) {
    withAny++
    if (c.status === 'ENABLED') enabledWithAny++
    for (const p of nonZero) {
      laneTally.set(String(p.placement), (laneTally.get(String(p.placement)) ?? 0) + 1)
      if (Number(p.percentage) > biggest) { biggest = Number(p.percentage); biggestName = c.name }
    }
  }
}
console.log(`     campaigns with a >0% placement multiplier : ${int(withAny)} of ${int(camps.length)}`)
console.log(`     …of them ENABLED                          : ${int(enabledWithAny)}`)
console.log(`     by lane                                   : ${[...laneTally.entries()].map(([k, v]) => `${k} ${v}`).join(' · ') || '(none)'}`)
console.log(`     largest                                   : +${biggest}% on "${biggestName}"`)
console.log(`     bidding strategy                          : ${[...strategyTally.entries()].map(([k, v]) => `${k} ${v}`).join(' · ')}`)
console.log(`\n     → an "effective max CPC" column is bid × (1 + placement%) × strategy factor.`)
console.log(`       It is meaningful on ${int(enabledWithAny)} ENABLED campaigns and identical to Bid on the rest.`)

console.log('')
await prisma.$disconnect()
