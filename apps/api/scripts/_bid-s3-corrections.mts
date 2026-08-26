/**
 * BID.S3 — resolve the three corrections the operator raised against shipped S2, then measure what
 * the drawer needs. READ-ONLY.
 *
 * 3.1 placement modifier: is the largest +400% (S2) or +300% (operator + the Placement study)?
 * 3.2 placement coverage: 172/68 (S2) or 165/58 (operator)?
 * 3.3 `manual`: 12 (S2) or 5 (operator)? And reconcile 2,540 vs 2,337 never-written.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { parseActor } = await import('../src/services/advertising/ads-changes.service.js')

const int = (n: number) => n.toLocaleString('en-IE')
const now = new Date()
console.log(`\n═══ BID.S3 — corrections · ${now.toLocaleString('en-GB', { timeZone: 'Europe/Rome' })} Rome ═══\n`)

// ── 3.1 + 3.2 · placement ────────────────────────────────────────────────────
console.log('3.1/3.2 · Placement — read from Campaign.dynamicBidding.placementBidding[]')
const camps = await prisma.campaign.findMany({ select: { id: true, name: true, status: true, dynamicBidding: true } })
interface PB { placement?: string; percentage?: number }
const laneMax = new Map<string, number>()
const laneCount = new Map<string, number>()
let anyPB = 0, nonZeroAny = 0, nonZeroEnabled = 0, biggest = 0, biggestName = '', biggestLane = ''
for (const c of camps) {
  const db = (c.dynamicBidding ?? {}) as { placementBidding?: PB[] }
  const list = Array.isArray(db.placementBidding) ? db.placementBidding : []
  if (list.length) anyPB++
  const nz = list.filter((p) => Number(p?.percentage) > 0)
  if (nz.length) { nonZeroAny++; if (c.status === 'ENABLED') nonZeroEnabled++ }
  for (const p of nz) {
    const lane = String(p.placement); const pct = Number(p.percentage)
    laneCount.set(lane, (laneCount.get(lane) ?? 0) + 1)
    if (pct > (laneMax.get(lane) ?? 0)) laneMax.set(lane, pct)
    if (pct > biggest) { biggest = pct; biggestName = c.name; biggestLane = lane }
  }
}
console.log(`  campaigns with a placementBidding ARRAY at all : ${int(anyPB)} of ${int(camps.length)}`)
console.log(`  …with a NON-ZERO entry                         : ${int(nonZeroAny)}`)
console.log(`  …of those, ENABLED                             : ${int(nonZeroEnabled)}`)
console.log('  by lane (campaigns · max %):')
for (const [lane, n] of [...laneCount.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`    ${lane.padEnd(26)} ${String(n).padStart(3)} · max +${laneMax.get(lane)}%`)
}
console.log(`  🔴 largest anywhere: +${biggest}% on "${biggestName}" (${biggestLane})`)

// is the bias moving? that is the clock hypothesis
const gale = camps.find((c) => c.name.includes('GALE') && c.name.includes('Category'))
if (gale) {
  const db = (gale.dynamicBidding ?? {}) as { placementBidding?: PB[] }
  console.log(`\n  "${gale.name}" right now: ${JSON.stringify(db.placementBidding)}`)
}
// does anything audit a placement change?
const placementFields = await prisma.campaignBidHistory.groupBy({
  by: ['field'], _count: { _all: true },
  where: { changedAt: { gte: new Date(now.getTime() - 60 * 86400_000) } },
})
console.log(`\n  CampaignBidHistory fields in 60 d: ${placementFields.map((f) => `${f.field} ${int(f._count._all)}`).join(' · ')}`)
const biasRows = await prisma.campaignBidHistory.findMany({
  where: { field: { in: ['placementBidding', 'placement', 'bidStrategy', 'dynamicBidding'] }, changedAt: { gte: new Date(now.getTime() - 3 * 86400_000) } },
  select: { entityId: true, oldValue: true, newValue: true, changedAt: true }, orderBy: { changedAt: 'desc' }, take: 6,
})
console.log(`  placement-ish audited changes in 3 d: ${biasRows.length}`)
for (const b of biasRows) console.log(`    ${b.changedAt.toISOString().slice(0, 16)} ${String(b.oldValue).slice(0, 40)} → ${String(b.newValue).slice(0, 40)}`)

// ── 3.3 · the `manual` predicate ─────────────────────────────────────────────
console.log('\n3.3 · `manual` — 🔴 AdvertisingActionLog.userId holds the ACTOR STRING, not an operator id')
const since60 = new Date(now.getTime() - 60 * 86400_000)
const logs = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BID_UPDATE', createdAt: { gte: since60 } },
  select: { entityId: true, userId: true },
})
const bySource = new Map<string, number>()
for (const l of logs) bySource.set(parseActor(l.userId).source, (bySource.get(parseActor(l.userId).source) ?? 0) + 1)
console.log(`  AD_BID_UPDATE rows in 60 d: ${int(logs.length)}`)
console.log(`  by parseActor(userId).source: ${[...bySource.entries()].map(([k, v]) => `${k} ${int(v)}`).join(' · ')}`)
const nullUser = logs.filter((l) => l.userId == null).length
const automationUser = logs.filter((l) => (l.userId ?? '').startsWith('automation:')).length
console.log(`  userId IS NULL: ${int(nullUser)} · userId starts with "automation:": ${int(automationUser)}`)
console.log(`  → S2's predicate was \`userId != null\`, which counts ${int(automationUser)} AUTOMATION rows as operator writes.`)

// the two candidate predicates, at campaign grain
const targetIds = [...new Set(logs.map((l) => l.entityId))]
const t2c = new Map<string, string>()
for (const t of await prisma.adTarget.findMany({ where: { id: { in: targetIds } }, select: { id: true, adGroup: { select: { campaignId: true } } } })) {
  t2c.set(t.id, t.adGroup.campaignId)
}
const campsS2 = new Set<string>(), campsCorrect = new Set<string>()
for (const l of logs) {
  const cid = t2c.get(l.entityId); if (!cid) continue
  if (l.userId != null) campsS2.add(cid)                                   // S2's predicate
  if (parseActor(l.userId).source === 'operator') campsCorrect.add(cid)    // the correct one
}
console.log(`  campaigns matched — S2 (\`userId != null\`): ${campsS2.size} · parseActor==='operator': ${campsCorrect.size}`)

// full bidder tally under the corrected predicate
const schedules = await prisma.adSchedule.findMany({ where: { enabled: true }, select: { campaignId: true, name: true, group: { select: { name: true } } } })
const sched = new Map<string, string>()
for (const s of schedules) if (!sched.has(s.campaignId)) sched.set(s.campaignId, s.group?.name ?? s.name)
const goalOf = (db: unknown) => { const o = (db ?? {}) as Record<string, unknown>; const v = o.targetAcos ?? o.targetACoS; return typeof v === 'number' && v > 0 ? v : null }
for (const [label, predicate] of [['S2 (userId != null)', campsS2], ['CORRECT (parseActor)', campsCorrect]] as const) {
  const tally = { schedule: 0, goal: 0, manual: 0, none: 0 }
  for (const c of camps.filter((x) => x.status === 'ENABLED')) {
    if (sched.has(c.id)) tally.schedule++
    else if (goalOf(c.dynamicBidding) != null) tally.goal++
    else if (predicate.has(c.id)) tally.manual++
    else tally.none++
  }
  console.log(`  ENABLED campaigns · ${label.padEnd(22)} schedule ${tally.schedule} · goal ${tally.goal} · manual ${tally.manual} · none ${tally.none}`)
}

// ── never-written, both denominators ─────────────────────────────────────────
console.log('\n· Never-written counts — the 2,540 vs 2,337 reconciliation')
const written = new Set((await prisma.campaignBidHistory.findMany({
  where: { entityType: 'AD_TARGET', field: { in: ['bid', 'defaultBid'] }, changedAt: { gte: since60 } },
  select: { entityId: true }, distinct: ['entityId'],
})).map((r) => r.entityId))
const T = await prisma.adTarget.count({ where: { isNegative: false } })
const A = await prisma.adTarget.count({ where: { isNegative: false, status: 'ENABLED' } })
const allT = await prisma.adTarget.findMany({ where: { isNegative: false }, select: { id: true, status: true } })
const neverT = allT.filter((t) => !written.has(t.id)).length
const neverA = allT.filter((t) => t.status === 'ENABLED' && !written.has(t.id)).length
console.log(`  T (all positive) ${int(T)} · never written ${int(neverT)}   ← S2 quoted 2,540 here`)
console.log(`  A (ENABLED)      ${int(A)} · never written ${int(neverA)}   ← the operator quoted 2,337 here`)
console.log('  → BOTH are right; they use different denominators. S2 quoted the T number in a')
console.log('    paragraph whose other figures were A. That is the denominator discipline S2 preached.')

console.log('')
await prisma.$disconnect()
