/**
 * BID.S2 — measure everything the column set depends on, before designing it.
 *
 * READ-ONLY. No writes, no mutations.
 *
 * Six questions the brief asks and does not answer:
 *   1. Is `AdTarget.updatedAt` really bumped hourly by the resync? (§6 — "I read the code, I did
 *      not measure it")
 *   2. How big is the drift-by-value population — "Changed outside Nexus"?
 *   3. What does each state chip actually count, at this hour?
 *   4. What does the bidder derivation resolve to?
 *   5. What is the sparkline's real coverage and points-per-entity?
 *   6. Is `suggestBids` as dead as the brief says, and is an Amazon-sourced suggestion reachable?
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')

const int = (n: number) => n.toLocaleString('en-IE')
const c2e = (c: number) => `€${(c / 100).toFixed(2)}`
const now = new Date()
const rome = now.toLocaleString('en-GB', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })
console.log(`\n═══ BID.S2 — measurement · ${rome} Rome (${now.toISOString()}) ═══\n`)
console.log('🔴 Every count below is a CLOCK READING. The rank engine floors bids at 00:00 Rome and')
console.log('   restores at 08:00, so the floor/suppression numbers are hour-dependent by design.\n')

// ── 1. is updatedAt bumped hourly regardless of a bid change? ────────────────
console.log('1 · Does the hourly resync bump updatedAt on rows whose bid did not move?')
const targets = await prisma.adTarget.findMany({
  where: { isNegative: false },
  select: {
    id: true, bidCents: true, status: true, updatedAt: true, lastSyncedAt: true,
    suppressedFromBidCents: true, expressionValue: true, kind: true, expressionType: true,
    adGroup: { select: { campaignId: true, campaign: { select: { id: true, name: true, status: true, marketplace: true, minBidCents: true, maxBidCents: true, bidsSuppressedAt: true, dynamicBidding: true } } } },
  },
})
console.log(`     positive targets: ${int(targets.length)}`)
const buckets = new Map<string, number>()
for (const t of targets) {
  const ageMin = Math.floor((now.getTime() - t.updatedAt.getTime()) / 60000)
  const b = ageMin < 60 ? '<1h' : ageMin < 120 ? '1-2h' : ageMin < 24 * 60 ? '2-24h' : ageMin < 7 * 24 * 60 ? '1-7d' : '>7d'
  buckets.set(b, (buckets.get(b) ?? 0) + 1)
}
console.log(`     updatedAt age: ${[...buckets.entries()].sort().map(([k, v]) => `${k} ${int(v)}`).join(' · ')}`)
// the tell: updatedAt within the last 2h on rows with NO bid write in 60 days
const since60 = new Date(now.getTime() - 60 * 86400_000)
const bidHist = await prisma.campaignBidHistory.findMany({
  where: { entityType: 'AD_TARGET', field: { in: ['bid', 'defaultBid'] }, changedAt: { gte: since60 } },
  select: { entityId: true, newValue: true, oldValue: true, changedAt: true, changedBy: true, reason: true },
  orderBy: { changedAt: 'desc' },
})
const everWritten = new Set(bidHist.map((h) => h.entityId))
const neverWritten = targets.filter((t) => !everWritten.has(t.id))
const neverWrittenFresh = neverWritten.filter((t) => now.getTime() - t.updatedAt.getTime() < 2 * 3600_000)
console.log(`     targets with NO bid-history row in 60 d: ${int(neverWritten.length)}`)
console.log(`     …of those, updatedAt moved in the last 2 h: ${int(neverWrittenFresh.length)}`)
console.log(neverWrittenFresh.length > neverWritten.length * 0.3
  ? '     🔴 CONFIRMED — updatedAt moves on rows that have never had a bid write. It is a sync\n        heartbeat, not a change signal. It CANNOT drive a "changed outside Nexus" chip.'
  : '     ⚠ NOT confirmed at this hour — the resync may not have run recently. Re-run after :45.')
const lastSyncSpread = targets.map((t) => t.lastSyncedAt).filter((d): d is Date => !!d).sort((a, b) => b.getTime() - a.getTime())
if (lastSyncSpread.length) {
  console.log(`     newest lastSyncedAt ${lastSyncSpread[0].toISOString()} · oldest ${lastSyncSpread[lastSyncSpread.length - 1].toISOString()}`)
  console.log(`     rows sharing the newest MINUTE: ${int(lastSyncSpread.filter((d) => d.getTime() >= lastSyncSpread[0].getTime() - 60000).length)}`)
}

// ── 2. drift by value — "Changed outside Nexus" ──────────────────────────────
console.log('\n2 · Drift by VALUE (AdTarget.bidCents vs the newest audited newValue)')
const lastAudited = new Map<string, { v: number | null; at: Date; by: string }>()
for (const h of bidHist) {
  if (lastAudited.has(h.entityId)) continue // ordered desc, first wins
  const n = h.newValue == null ? null : Number(h.newValue)
  lastAudited.set(h.entityId, { v: Number.isFinite(n as number) ? (n as number) : null, at: h.changedAt, by: h.changedBy })
}
let neverAudited = 0, agrees = 0, drifted = 0, unparseable = 0
const driftSample: string[] = []
// 🔴 units: is newValue cents or euros? Check before comparing.
const unitProbe = [...lastAudited.entries()].slice(0, 400)
  .map(([id, a]) => ({ a, t: targets.find((x) => x.id === id) })).filter((x) => x.t && x.a.v != null)
const asCents = unitProbe.filter((x) => x.a.v === x.t!.bidCents).length
const asEuros = unitProbe.filter((x) => Math.round((x.a.v as number) * 100) === x.t!.bidCents).length
console.log(`     unit probe over ${unitProbe.length} audited targets: newValue==bidCents ${asCents} · newValue*100==bidCents ${asEuros}`)
const newValueIsCents = asCents >= asEuros
console.log(`     → treating newValue as ${newValueIsCents ? 'CENTS' : 'EUROS'}`)
for (const t of targets) {
  const a = lastAudited.get(t.id)
  if (!a) { neverAudited++; continue }
  if (a.v == null) { unparseable++; continue }
  const auditedCents = newValueIsCents ? a.v : Math.round(a.v * 100)
  if (auditedCents === t.bidCents) agrees++
  else {
    drifted++
    if (driftSample.length < 5) driftSample.push(`${(t.expressionValue || `(${t.kind})`).slice(0, 26)} — audited ${c2e(auditedCents)} → now ${c2e(t.bidCents)} · last by ${a.by} at ${a.at.toISOString().slice(0, 16)}`)
  }
}
console.log(`     never audited      ${int(neverAudited)}  (no bid-history row in 60 d — nothing to draw, nothing to compare)`)
console.log(`     audited & agrees   ${int(agrees)}`)
console.log(`     🔴 DRIFTED         ${int(drifted)}  ← "Changed outside Nexus"`)
console.log(`     unparseable        ${int(unparseable)}`)
for (const s of driftSample) console.log(`        · ${s}`)

// ── 3. the state chips, at this hour ─────────────────────────────────────────
console.log('\n3 · State chip populations')
const enabled = targets.filter((t) => t.status === 'ENABLED')
const inAuction = enabled.filter((t) => t.adGroup.campaign.status === 'ENABLED')
console.log(`     ENABLED positive targets           ${int(enabled.length)}   ← denominator A`)
console.log(`     …in an ENABLED campaign (auction)  ${int(inAuction.length)}   ← denominator B`)
const chip = (label: string, f: (t: (typeof targets)[number]) => boolean) => {
  const a = enabled.filter(f).length, b = inAuction.filter(f).length
  console.log(`     ${label.padEnd(30)} ${String(int(a)).padStart(6)} of A · ${String(int(b)).padStart(6)} of B`)
  return a
}
chip('Suppressed (restore value)', (t) => t.suppressedFromBidCents != null)
chip('Min-bid window (campaign)', (t) => t.adGroup.campaign.bidsSuppressedAt != null)
chip('At floor <=2c, no restore', (t) => t.bidCents <= 2 && t.suppressedFromBidCents == null && t.adGroup.campaign.bidsSuppressedAt == null)
chip('At floor <=5c, no restore', (t) => t.bidCents <= 5 && t.suppressedFromBidCents == null && t.adGroup.campaign.bidsSuppressedAt == null)
chip('Out of band (> maxBidCents)', (t) => t.adGroup.campaign.maxBidCents != null && t.bidCents > t.adGroup.campaign.maxBidCents)
chip('Below floor (< minBidCents)', (t) => t.adGroup.campaign.minBidCents != null && t.bidCents < t.adGroup.campaign.minBidCents)
chip('Unnamed (no expression)', (t) => !(t.expressionValue ?? '').trim())
chip('Changed outside Nexus', (t) => {
  const a = lastAudited.get(t.id); if (!a || a.v == null) return false
  return (newValueIsCents ? a.v : Math.round(a.v * 100)) !== t.bidCents
})
chip('Never audited', (t) => !lastAudited.has(t.id))

// ── 4. the bidder ────────────────────────────────────────────────────────────
console.log('\n4 · Bidder, per campaign')
const campaigns = await prisma.campaign.findMany({
  select: { id: true, name: true, status: true, marketplace: true, dynamicBidding: true },
})
const schedules = await prisma.adSchedule.findMany({ where: { enabled: true }, select: { id: true, campaignId: true, name: true } })
const schedByCampaign = new Map<string, { id: string; name: string }>()
for (const s of schedules) if (!schedByCampaign.has(s.campaignId)) schedByCampaign.set(s.campaignId, { id: s.id, name: s.name })
const manualWriters = await prisma.advertisingActionLog.findMany({
  where: { actionType: 'AD_BID_UPDATE', createdAt: { gte: since60 }, userId: { not: null } },
  select: { entityId: true, userId: true },
})
const manualTargetIds = new Set(manualWriters.map((m) => m.entityId))
const campaignOfTarget = new Map(targets.map((t) => [t.id, t.adGroup.campaignId]))
const manualCampaigns = new Set([...manualTargetIds].map((id) => campaignOfTarget.get(id)).filter((x): x is string => !!x))
const goalOf = (db: unknown) => {
  const o = (db ?? {}) as Record<string, unknown>
  const v = o.targetAcos ?? o.targetACoS ?? o.target_acos
  return typeof v === 'number' && v > 0 ? v : null
}
const bidderOf = (c: { id: string; dynamicBidding: unknown }) =>
  schedByCampaign.has(c.id) ? 'schedule' : goalOf(c.dynamicBidding) != null ? 'goal' : manualCampaigns.has(c.id) ? 'manual' : 'none'
const enabledCamps = campaigns.filter((c) => c.status === 'ENABLED')
for (const [label, set] of [['ALL 220 campaigns', campaigns], ['ENABLED campaigns', enabledCamps]] as const) {
  const tally: Record<string, number> = { schedule: 0, goal: 0, manual: 0, none: 0 }
  for (const c of set) tally[bidderOf(c)]++
  console.log(`     ${label.padEnd(20)} schedule ${tally.schedule} · goal ${tally.goal} · manual ${tally.manual} · none ${tally.none}`)
}
console.log(`     enabled AdSchedule rows: ${int(schedules.length)} across ${int(schedByCampaign.size)} campaigns`)
console.log(`     sample schedule names: ${schedules.slice(0, 3).map((s) => `"${s.name}"`).join(' · ')}`)
const campsWithGoal = campaigns.filter((c) => goalOf(c.dynamicBidding) != null)
console.log(`     campaigns with dynamicBidding.targetAcos: ${int(campsWithGoal.length)}`)

// ── 5. sparkline coverage ────────────────────────────────────────────────────
console.log('\n5 · Sparkline coverage (CampaignBidHistory, AD_TARGET, field in bid/defaultBid, 60 d)')
const pointsPer = new Map<string, number>()
for (const h of bidHist) pointsPer.set(h.entityId, (pointsPer.get(h.entityId) ?? 0) + 1)
const counts = [...pointsPer.values()].sort((a, b) => a - b)
const pctl = (p: number) => counts.length ? counts[Math.min(counts.length - 1, Math.floor(counts.length * p))] : 0
console.log(`     rows ${int(bidHist.length)} · distinct targets with ≥1 point ${int(pointsPer.size)} of ${int(targets.length)} (${((pointsPer.size / targets.length) * 100).toFixed(1)}%)`)
console.log(`     points per target: min ${counts[0] ?? 0} · median ${pctl(0.5)} · p90 ${pctl(0.9)} · max ${counts[counts.length - 1] ?? 0}`)
const enabledWithCurve = enabled.filter((t) => pointsPer.has(t.id)).length
console.log(`     of the ${int(enabled.length)} ENABLED targets, ${int(enabledWithCurve)} have a curve (${((enabledWithCurve / enabled.length) * 100).toFixed(1)}%)`)
// 🔴 the two populations the brief says must not imply each other
const perf = await prisma.amazonAdsDailyPerformance.groupBy({
  by: ['localEntityId'],
  where: { entityType: 'AD_TARGET', date: { gte: new Date(now.getTime() - 30 * 86400_000) } },
  _sum: { clicks: true },
})
const withMetrics = new Set(perf.map((p) => p.localEntityId).filter((x): x is string => !!x))
const curveSet = new Set(pointsPer.keys())
const both = enabled.filter((t) => curveSet.has(t.id) && withMetrics.has(t.id)).length
const curveOnly = enabled.filter((t) => curveSet.has(t.id) && !withMetrics.has(t.id)).length
const metricsOnly = enabled.filter((t) => !curveSet.has(t.id) && withMetrics.has(t.id)).length
const neither = enabled.filter((t) => !curveSet.has(t.id) && !withMetrics.has(t.id)).length
console.log(`     ENABLED × {curve, metrics}: both ${int(both)} · curve-only ${int(curveOnly)} · metrics-only ${int(metricsOnly)} · neither ${int(neither)}`)
console.log(`     🔴 curve-only ${int(curveOnly)} and metrics-only ${int(metricsOnly)} prove the two sets are NOT the same.`)
// intended vs delivered — did the recent writes land?
const failing = await prisma.advertisingActionLog.count({
  where: { actionType: 'AD_BID_UPDATE', createdAt: { gte: new Date(now.getTime() - 7 * 86400_000) }, amazonResponseStatus: 'FAILED' },
})
console.log(`     AD_BID_UPDATE rows FAILED in the last 7 d: ${int(failing)}`)

// ── 6. suggestBids, and whether Amazon's own suggestion is reachable ─────────
console.log('\n6 · Suggested bid — is the corpus really empty?')
const dead = await prisma.adTarget.aggregate({ where: { isNegative: false }, _max: { spendCents: true, clicks: true, salesCents: true, impressions: true } })
console.log(`     AdTarget MAX: spendCents ${dead._max.spendCents} · clicks ${dead._max.clicks} · salesCents ${dead._max.salesCents} · impressions ${dead._max.impressions}`)
const corpus = await prisma.adTarget.count({ where: { kind: 'KEYWORD', clicks: { gt: 0 }, spendCents: { gt: 0 } } })
console.log(`     suggestBids corpus (kind=KEYWORD AND clicks>0 AND spendCents>0): ${int(corpus)}`)
console.log(corpus === 0 ? '     🔴 CONFIRMED empty → accountMedian null → every suggestion is the hard-coded 50¢ default.' : '     ⚠ non-empty, re-read the service.')
// is there any stored Amazon suggested bid anywhere?
const anyBidSuggestionTable = await prisma.$queryRawUnsafe<Array<{ table_name: string }>>(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name ILIKE '%suggest%' OR table_name ILIKE '%recommend%')`,
).catch(() => [])
console.log(`     tables matching suggest/recommend: ${anyBidSuggestionTable.length ? anyBidSuggestionTable.map((t) => t.table_name).join(', ') : '(none)'}`)

// ── 7. effective max CPC feasibility ─────────────────────────────────────────
console.log('\n7 · Effective max CPC — is the substrate there?')
const campsWithPlacement = await prisma.campaign.findMany({
  where: { OR: [{ bidStrategyJson: { not: null } }, { placementBidsJson: { not: null } }] },
  select: { id: true, name: true, bidStrategyJson: true, placementBidsJson: true },
}).catch(() => [] as Array<{ id: string; name: string; bidStrategyJson: unknown; placementBidsJson: unknown }>)
console.log(`     campaigns carrying a bidStrategy/placement JSON: ${int(campsWithPlacement.length)}`)
if (campsWithPlacement[0]) {
  console.log(`     sample bidStrategyJson : ${JSON.stringify(campsWithPlacement[0].bidStrategyJson).slice(0, 150)}`)
  console.log(`     sample placementBidsJson: ${JSON.stringify(campsWithPlacement[0].placementBidsJson).slice(0, 150)}`)
}
const rankTargets = await prisma.rankTarget.findMany({ select: { key: true, cpcCapPct: true, maxCpcCents: true } }).catch(() => [] as Array<{ key: string; cpcCapPct: number | null; maxCpcCents: number | null }>)
console.log(`     RankTarget rows ${int(rankTargets.length)} · with cpcCapPct ${int(rankTargets.filter((r) => r.cpcCapPct != null).length)} · with maxCpcCents ${int(rankTargets.filter((r) => r.maxCpcCents != null).length)}`)

// ── 8. the band ──────────────────────────────────────────────────────────────
console.log('\n8 · Band (Campaign.minBidCents / maxBidCents)')
const allCamps = await prisma.campaign.findMany({ select: { id: true, minBidCents: true, maxBidCents: true, status: true } })
console.log(`     campaigns ${int(allCamps.length)} · minBidCents set ${int(allCamps.filter((c) => c.minBidCents != null).length)} · maxBidCents set ${int(allCamps.filter((c) => c.maxBidCents != null).length)}`)
const maxVals = new Map<number, number>()
for (const c of allCamps) if (c.maxBidCents != null) maxVals.set(c.maxBidCents, (maxVals.get(c.maxBidCents) ?? 0) + 1)
console.log(`     maxBidCents values: ${[...maxVals.entries()].sort((a, b) => a[0] - b[0]).map(([v, n]) => `${c2e(v)}×${n}`).join(' · ')}`)
const zeroFloor = allCamps.filter((c) => c.minBidCents === 0).length
console.log(`     campaigns with minBidCents === 0 (a declared floor of zero): ${int(zeroFloor)}`)

console.log('')
await prisma.$disconnect()
