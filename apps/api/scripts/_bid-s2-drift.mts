/**
 * BID.S2 — two things probe 1 could not settle. READ-ONLY.
 *
 *  A. 🔴 The 147 "drifted" rows all looked like `audited €0.02 → now €X, last written by
 *     automation:rank-defend-… at 22:0x`. That is NOT a Seller Central edit — it is our own rank
 *     engine's nightly FLOOR being audited and its 08:00 RESTORE apparently not being. If true,
 *     "Changed outside Nexus" is the wrong label for most of that population, AND a sparkline
 *     drawn from CampaignBidHistory shows only the down-strokes of a sawtooth.
 *
 *  B. Probe 1's §7 used `.catch(() => [])` around a query naming `placementBidsJson` and
 *     `cpcCapPct`, neither of which exists — so it reported 0 for both. Re-measured against the
 *     real fields: placement adjustments live in `Campaign.bidStrategyJson.adjustments[]`, and
 *     RankTarget carries `maxCpcCents` / `biasPct` / `maxBiasPct`, not `cpcCapPct`.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const c2e = (c: number) => `€${(c / 100).toFixed(2)}`
const now = new Date()
console.log(`\n═══ BID.S2 — drift cause + effective-CPC substrate · ${now.toLocaleString('en-GB', { timeZone: 'Europe/Rome' })} Rome ═══\n`)

// ── A. is the RESTORE audited? ───────────────────────────────────────────────
console.log('A · Is the 08:00 restore recorded in CampaignBidHistory?')
const since48 = new Date(now.getTime() - 48 * 3600_000)

// pick a target that drifted: audited at the floor, currently well above it
const recent = await prisma.campaignBidHistory.findMany({
  where: { entityType: 'AD_TARGET', field: { in: ['bid', 'defaultBid'] }, changedAt: { gte: since48 } },
  select: { entityId: true, oldValue: true, newValue: true, changedAt: true, changedBy: true, reason: true },
  orderBy: { changedAt: 'desc' },
})
console.log(`     CampaignBidHistory AD_TARGET bid rows in 48 h: ${int(recent.length)}`)
const byEntity = new Map<string, typeof recent>()
for (const r of recent) { const a = byEntity.get(r.entityId) ?? []; a.push(r); byEntity.set(r.entityId, a) }

// classify every 48h row as a cut-to-floor or a raise
let toFloor = 0, fromFloor = 0, other = 0
for (const r of recent) {
  const nv = Number(r.newValue), ov = Number(r.oldValue)
  if (Number.isFinite(nv) && nv <= 2) toFloor++
  else if (Number.isFinite(ov) && ov <= 2 && Number.isFinite(nv) && nv > 2) fromFloor++
  else other++
}
console.log(`     rows whose newValue <= 2c (a FLOOR)      : ${int(toFloor)}`)
console.log(`     rows whose oldValue <= 2c and newValue > : ${int(fromFloor)}   ← a RESTORE`)
console.log(`     everything else                          : ${int(other)}`)
console.log(toFloor > 0 && fromFloor === 0
  ? '     🔴 The floor is audited and the restore is NOT. CampaignBidHistory holds only the\n        down-strokes, so a curve drawn from it descends forever and never comes back.'
  : `     ✅ Both directions appear in the audit table (${int(fromFloor)} restores).`)

// hour-of-day profile of the audited writes
const hours = new Map<number, number>()
for (const r of recent) {
  const h = Number(r.changedAt.toLocaleString('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', hour12: false }))
  hours.set(h, (hours.get(h) ?? 0) + 1)
}
console.log(`     audited-write hour profile (Rome): ${[...hours.entries()].sort((a, b) => a[0] - b[0]).map(([h, n]) => `${String(h).padStart(2, '0')}:${n}`).join(' ')}`)

// one worked example
const example = [...byEntity.entries()].find(([, rows]) => rows.length >= 2)
if (example) {
  const [id, rows] = example
  const t = await prisma.adTarget.findUnique({ where: { id }, select: { expressionValue: true, bidCents: true, updatedAt: true, suppressedFromBidCents: true } })
  console.log(`\n     worked example — "${t?.expressionValue || '(unnamed)'}"  live bid ${c2e(t?.bidCents ?? 0)} · suppressedFrom ${t?.suppressedFromBidCents ?? 'null'}`)
  for (const r of rows.slice(0, 8)) {
    console.log(`        ${r.changedAt.toLocaleString('en-GB', { timeZone: 'Europe/Rome' })}  ${String(r.oldValue).padStart(5)} → ${String(r.newValue).padStart(5)}  ${r.changedBy.slice(0, 42)}  ${(r.reason ?? '').slice(0, 46)}`)
  }
  // does the ACTION LOG hold the restore that the bid-history table is missing?
  const logs = await prisma.advertisingActionLog.findMany({
    where: { entityId: id, actionType: 'AD_BID_UPDATE', createdAt: { gte: since48 } },
    select: { createdAt: true, payloadBefore: true, payloadAfter: true, amazonResponseStatus: true },
    orderBy: { createdAt: 'desc' }, take: 8,
  })
  console.log(`\n     AdvertisingActionLog rows for the SAME target in 48 h: ${logs.length}`)
  for (const l of logs) {
    const b = (l.payloadBefore ?? {}) as Record<string, unknown>
    const a = (l.payloadAfter ?? {}) as Record<string, unknown>
    console.log(`        ${l.createdAt.toLocaleString('en-GB', { timeZone: 'Europe/Rome' })}  ${JSON.stringify(b).slice(0, 40)} → ${JSON.stringify(a).slice(0, 40)}  ${l.amazonResponseStatus ?? '—'}`)
  }
}

// account-wide: do the two tables disagree about how many bid writes happened?
const logCount = await prisma.advertisingActionLog.count({ where: { actionType: 'AD_BID_UPDATE', entityType: 'AD_TARGET', createdAt: { gte: since48 } } })
console.log(`\n     48 h totals — CampaignBidHistory ${int(recent.length)} · AdvertisingActionLog ${int(logCount)}`)
console.log(`     🔴 If the log holds materially more, the SPARKLINE SOURCE should be the log, not the history table.`)

// ── B. effective max CPC substrate, with the RIGHT field names ───────────────
console.log('\nB · Effective max CPC — measured against fields that exist')
const campsAll = await prisma.campaign.findMany({ select: { id: true, name: true, status: true, bidStrategyJson: true, maxBidCents: true } })
let withStrategy = 0, withAdjustments = 0
const adjTally = new Map<string, number>()
let maxAdj = 0; let maxAdjName = ''
for (const c of campsAll) {
  const j = c.bidStrategyJson as { strategy?: string; adjustments?: Array<{ placement?: string; percentage?: number }> } | null
  if (!j) continue
  withStrategy++
  const adj = Array.isArray(j.adjustments) ? j.adjustments : []
  if (adj.length) withAdjustments++
  for (const a of adj) {
    const p = String(a.placement ?? '?')
    adjTally.set(p, (adjTally.get(p) ?? 0) + 1)
    if (Number(a.percentage) > maxAdj) { maxAdj = Number(a.percentage); maxAdjName = c.name }
  }
}
console.log(`     campaigns with bidStrategyJson      : ${int(withStrategy)} of ${int(campsAll.length)}`)
console.log(`     …carrying a non-empty adjustments[] : ${int(withAdjustments)}`)
console.log(`     adjustments by placement            : ${[...adjTally.entries()].map(([p, n]) => `${p} ${n}`).join(' · ') || '(none)'}`)
console.log(`     largest multiplier                  : +${maxAdj}%  on "${maxAdjName}"`)
const rt = await prisma.rankTarget.findMany({ select: { key: true, name: true, maxCpcCents: true, biasPct: true, maxBiasPct: true, allOut: true } })
console.log(`     RankTarget rows ${int(rt.length)} · with maxCpcCents ${int(rt.filter((r) => r.maxCpcCents != null).length)} · with maxBiasPct ${int(rt.filter((r) => r.maxBiasPct != null).length)} · allOut ${int(rt.filter((r) => r.allOut).length)}`)
console.log(`     🔴 there is NO cpcCapPct field on RankTarget — probe 1 asked for one and its`)
console.log(`        .catch(() => []) reported "0 RankTarget rows", which was a wrong field name, not a zero.`)

// what an effective-CPC column could actually multiply by
const enabledCamps = campsAll.filter((c) => c.status === 'ENABLED')
let enabledWithAdj = 0
for (const c of enabledCamps) {
  const j = c.bidStrategyJson as { adjustments?: Array<{ percentage?: number }> } | null
  if (j?.adjustments?.some((a) => Number(a.percentage) > 0)) enabledWithAdj++
}
console.log(`     ENABLED campaigns with a >0% placement adjustment: ${int(enabledWithAdj)} of ${int(enabledCamps.length)}`)

console.log('')
await prisma.$disconnect()
