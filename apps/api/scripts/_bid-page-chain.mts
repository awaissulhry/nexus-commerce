/**
 * BID page study — is the "19 consecutive cuts" chain a RATCHET or a daily cycle?
 *
 * READ-ONLY. Every step in the longest chain is the identical €0.38 → €0.02 move, once a night,
 * with the reason "rank — pause target → bids floored (no-pause)". That is not compounding. But
 * the bid is back at €0.38 by the next night, so a RESTORE must exist and must be missing from
 * the AD_BID_UPDATE set the chain detector reads. This finds out which.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const TARGET = process.argv[2] ?? 'cmr28mgl50019qq010p4nqnhg'
const pad = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n))
const int = (n: number) => n.toLocaleString('en-IE')
const ts = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ')

console.log(`\n═══ every recorded event for target ${TARGET} ═══\n`)

const logs = await prisma.advertisingActionLog.findMany({
  where: { entityId: TARGET },
  select: { actionType: true, userId: true, payloadBefore: true, payloadAfter: true, createdAt: true, amazonResponseStatus: true, outboundQueueId: true },
  orderBy: { createdAt: 'asc' },
})
console.log(`AdvertisingActionLog rows (ALL actionTypes): ${int(logs.length)}`)
const byType = new Map<string, number>()
for (const l of logs) byType.set(l.actionType, (byType.get(l.actionType) ?? 0) + 1)
console.log(`  by actionType: ${[...byType].map(([k, v]) => `${k}=${int(v)}`).join(' · ')}`)

const hist = await prisma.campaignBidHistory.findMany({
  where: { entityId: TARGET },
  select: { changedAt: true, field: true, oldValue: true, newValue: true, changedBy: true, reason: true },
  orderBy: { changedAt: 'asc' },
})
console.log(`CampaignBidHistory rows: ${int(hist.length)}`)

console.log(`\n── CampaignBidHistory, in order (the spine — every value change) ──`)
console.log(`${pad('  when', 20)} ${pad('field', 12)} ${pad('old', 7)}→${pad('new', 7)} reason`)
for (const h of hist.slice(0, 60)) {
  console.log(`  ${pad(ts(h.changedAt), 18)} ${pad(h.field, 12)} ${pad(String(h.oldValue), 7)}→${pad(String(h.newValue), 7)} ${(h.reason ?? '—').slice(0, 60)}`)
}
if (hist.length > 60) console.log(`  … ${int(hist.length - 60)} more`)

console.log(`\n── AdvertisingActionLog, in order ──`)
const bid = (v: unknown) => { const o = v as Record<string, unknown> | null; const x = o?.bidCents ?? o?.bid; return typeof x === 'number' ? x : null }
for (const l of logs.slice(0, 60)) {
  console.log(`  ${pad(ts(l.createdAt), 18)} ${pad(l.actionType, 24)} ${String(bid(l.payloadBefore))}→${String(bid(l.payloadAfter))}  ${pad(String(l.amazonResponseStatus), 8)} ${String(l.userId).slice(0, 40)}`)
}
if (logs.length > 60) console.log(`  … ${int(logs.length - 60)} more`)

// The decisive count: how many of this target's bid history rows are RAISES, and do they
// carry an AdvertisingActionLog row at the same instant?
const raises = hist.filter((h) => (h.field === 'bid') && Number(h.newValue) > Number(h.oldValue))
const cuts = hist.filter((h) => (h.field === 'bid') && Number(h.newValue) < Number(h.oldValue))
console.log(`\n── the answer ──`)
console.log(`  CampaignBidHistory bid rows: ${int(hist.filter((h) => h.field === 'bid').length)}  ·  raises ${int(raises.length)}  ·  cuts ${int(cuts.length)}`)
const logAt = new Set(logs.map((l) => Math.round(+l.createdAt / 5_000)))
const raisesWithLog = raises.filter((h) => logAt.has(Math.round(+h.changedAt / 5_000))).length
const cutsWithLog = cuts.filter((h) => logAt.has(Math.round(+h.changedAt / 5_000))).length
console.log(`  raises that also produced an AdvertisingActionLog row: ${int(raisesWithLog)} of ${int(raises.length)}`)
console.log(`  cuts   that also produced an AdvertisingActionLog row: ${int(cutsWithLog)} of ${int(cuts.length)}`)

// And account-wide: is the asymmetry general?
const SINCE = new Date(Date.now() - 60 * 86_400_000)
const allHist = await prisma.campaignBidHistory.findMany({
  where: { changedAt: { gte: SINCE }, field: { in: ['bid', 'defaultBid'] } },
  select: { oldValue: true, newValue: true, reason: true },
})
let up = 0, down = 0, same = 0
for (const h of allHist) {
  const o = Number(h.oldValue), n = Number(h.newValue)
  if (!Number.isFinite(o) || !Number.isFinite(n)) continue
  if (n > o) up++; else if (n < o) down++; else same++
}
console.log(`\n── account-wide CampaignBidHistory (bid+defaultBid), 60d ──`)
console.log(`  rows ${int(allHist.length)} · raises ${int(up)} · cuts ${int(down)} · no change ${int(same)}`)
console.log(`  ← compare with the AdvertisingActionLog split the tab study reported (9,866 up / 11,725 down)`)

await prisma.$disconnect()
