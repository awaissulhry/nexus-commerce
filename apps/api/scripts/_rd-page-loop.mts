// RD page study — is the loop CLOSED? Which target governs which hours, what the engine
// would actually decide, and how fresh each of its two signals is. Read-only.
import '../src/env.js'
import prisma from '../src/db.js'
import { resolveActiveTargetKey, computeStep, biasBand, cpcCapPct, strategyHeadroom, type RankTargetSpec, type ScheduleWindow } from '../src/services/advertising/rank-controller.js'
import { applyTargetOverrides } from '../src/jobs/ad-rank-defend.job.js'
import { analyzeTopOfSearch } from '../src/services/advertising/ads-top-of-search.service.js'
import { sqpImpressionShareForAsins } from '../src/services/advertising/sqp.service.js'

const pct = (n: number | null | undefined) => (n == null ? 'null' : `${n}%`)

async function main() {
  const targets = await prisma.rankTarget.findMany()
  const byKey = new Map(targets.map((t) => [t.key, t]))
  const toSpec = (t: (typeof targets)[number]): RankTargetSpec => ({
    key: t.key, placement: t.placement, targetISPct: t.targetISPct, acosCapPct: t.acosCapPct,
    maxCpcCents: t.maxCpcCents, biasPct: t.biasPct, pause: t.pause, floorBidCents: t.floorBidCents,
    allOut: t.allOut, jumpStartPct: t.jumpStartPct, stepUpPct: t.stepUpPct, stepDownPct: t.stepDownPct,
    maxBiasPct: t.maxBiasPct, keepClimbing: t.keepClimbing, lanes: Array.isArray(t.lanes) ? (t.lanes as never) : null,
    bidMode: t.bidMode, bidValueCents: t.bidValueCents, bidDeltaPct: t.bidDeltaPct,
  })

  console.log('=== A. CAN EACH TARGET CHASE AT ALL? (biasBand — ceiling>floor ⇒ closed loop) ===')
  for (const t of targets) {
    const s = toSpec(t)
    const b = biasBand(s)
    const canChase = s.allOut || b.ceiling > b.floor
    console.log(`${t.key.padEnd(15)} floor=${String(b.floor).padStart(3)}% ceiling=${String(b.ceiling).padStart(3)}% canChase=${canChase ? 'YES' : 'NO '} ${canChase ? '' : `⇒ IS target ${pct(t.targetISPct)} and ACoS cap ${pct(t.acosCapPct)} are NEVER READ`}`)
  }

  console.log('\n=== B. HOURS OF THE WEEK each target actually governs, per LIVE group ===')
  const groups = await prisma.rankScheduleGroup.findMany({ where: { enabled: true } })
  const totals = new Map<string, number>()
  for (const g of groups) {
    const wins = (Array.isArray(g.windows) ? g.windows : []) as ScheduleWindow[]
    const hist = new Map<string, number>()
    for (let d = 0; d < 7; d++) for (let h = 0; h < 24; h++) {
      const k = resolveActiveTargetKey(wins, g.defaultTargetKey, d, h) ?? '(nothing)'
      hist.set(k, (hist.get(k) ?? 0) + 1)
      totals.set(k, (totals.get(k) ?? 0) + 1)
    }
    const members = await prisma.adSchedule.count({ where: { groupId: g.id } })
    console.log(`${g.name} (${members} campaigns): ` + [...hist.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}h (${Math.round((n / 168) * 100)}%)`).join('  '))
  }
  console.log(`ALL LIVE GROUPS: ` + [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k}=${n}h`).join('  '))

  console.log('\n=== C. LIVE placement bias on the 33 member campaigns vs what the loop would hold ===')
  const scheds = await prisma.adSchedule.findMany({ where: { enabled: true, groupId: { in: groups.map((g) => g.id) } } })
  const camps = await prisma.campaign.findMany({
    where: { id: { in: scheds.map((s) => s.campaignId) } },
    select: { id: true, name: true, marketplace: true, dynamicBidding: true, biddingStrategy: true, status: true, deliveryReasons: true },
  })
  const campById = new Map(camps.map((c) => [c.id, c]))

  // The engine's TOP-lane signal, exactly as the job reads it.
  const markets = [...new Set(camps.map((c) => c.marketplace).filter(Boolean))] as string[]
  const sig = new Map<string, { topIS: number | null; topAcos: number | null }>()
  for (const mk of markets) {
    const { rows } = await analyzeTopOfSearch({ marketplace: mk, windowDays: 14 })
    for (const r of rows) sig.set(r.campaignId, { topIS: r.topIS, topAcos: r.topAcos })
  }
  console.log(`analyzeTopOfSearch returned signals for ${sig.size} of ${camps.length} member campaigns (markets: ${markets.join(',')})`)

  // Highest live base bid per campaign — the number the CPC ceiling is measured against.
  const maxBase = new Map<string, number>()
  const agRows = await prisma.adGroup.groupBy({ by: ['campaignId'], where: { campaignId: { in: camps.map((c) => c.id) } }, _max: { defaultBidCents: true, suppressedFromBidCents: true } })
  for (const r of agRows) { const v = Math.max(r._max.defaultBidCents ?? 0, r._max.suppressedFromBidCents ?? 0); if (v > 0) maxBase.set(r.campaignId, v) }
  const agIdx = await prisma.adGroup.findMany({ where: { campaignId: { in: camps.map((c) => c.id) } }, select: { id: true, campaignId: true } })
  const campByAg = new Map(agIdx.map((g) => [g.id, g.campaignId]))
  const tg = await prisma.adTarget.groupBy({ by: ['adGroupId'], where: { adGroup: { campaignId: { in: camps.map((c) => c.id) } }, isNegative: false }, _max: { bidCents: true, suppressedFromBidCents: true } })
  for (const r of tg) { const cid = campByAg.get(r.adGroupId); if (!cid) continue; const v = Math.max(r._max.bidCents ?? 0, r._max.suppressedFromBidCents ?? 0); if (v > (maxBase.get(cid) ?? 0)) maxBase.set(cid, v) }

  const nowRome = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Rome', weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(new Date())
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(nowRome.find((p) => p.type === 'weekday')!.value)
  const hour = parseInt(nowRome.find((p) => p.type === 'hour')!.value, 10) % 24
  console.log(`Rome now: day=${day} hour=${hour}\n`)

  let closed = 0, open = 0
  for (const s of scheds) {
    const c = campById.get(s.campaignId); if (!c) continue
    const g = groups.find((x) => x.id === s.groupId)!
    const key = resolveActiveTargetKey((Array.isArray(s.windows) ? s.windows : []) as ScheduleWindow[], s.defaultTargetKey, day, hour)
    if (!key) { console.log(`  ${c.name}: resolves to NOTHING`); continue }
    const t = byKey.get(key); if (!t) { console.log(`  ${c.name}: DANGLING key ${key}`); continue }
    const spec = applyTargetOverrides(toSpec(t), s.targetOverrides as never)
    const b = biasBand(spec)
    const canChase = spec.allOut || b.ceiling > b.floor
    canChase ? closed++ : open++
    const db = (c.dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }> }
    const cur = db.placementBidding?.find((x) => x.placement === spec.placement)?.percentage ?? 0
    const sg = sig.get(c.id) ?? { topIS: null, topAcos: null }
    const cap = cpcCapPct(spec.maxCpcCents, maxBase.get(c.id), strategyHeadroom(c.biddingStrategy))
    const d = spec.pause ? { action: 'pause', nextPct: cur, reason: `floor bids` } : computeStep(spec, { currentPct: cur, achievedISFraction: spec.placement === 'PLACEMENT_TOP' ? sg.topIS : null, achievedAcosFraction: spec.placement === 'PLACEMENT_TOP' ? sg.topAcos : null, lossDetected: false })
    console.log(`  ${c.name.slice(0, 46).padEnd(46)} | ${key.padEnd(14)} | ${canChase ? 'CLOSED' : 'open  '} | band ${b.floor}-${b.ceiling}% | live ${spec.placement === 'PLACEMENT_TOP' ? 'Top' : spec.placement === 'PLACEMENT_REST_OF_SEARCH' ? 'Rest' : 'Prod'}=${cur}% | topIS=${sg.topIS == null ? 'null' : (sg.topIS * 100).toFixed(1) + '%'} topAcos=${sg.topAcos == null ? 'null' : (sg.topAcos * 100).toFixed(0) + '%'} | maxBase=${maxBase.get(c.id) ?? 'none'}¢ cpcCap=${cap ? cap.capPct + '%' + (cap.baseAlone ? ' BASE-ALONE!' : '') : 'none'} | → ${d.action} ${d.nextPct}% (${d.reason})`)
  }
  console.log(`\nCLOSED-loop campaigns (ceiling>floor, chases a signal): ${closed}   OPEN-loop (snap-and-hold): ${open}`)

  console.log('\n=== D. SIGNAL FRESHNESS — both lanes ===')
  const latestPlacement = await prisma.amazonAdsPlacementReport.findFirst({ where: { placement: 'Top of Search on-Amazon' }, orderBy: { date: 'desc' }, select: { date: true } })
  const placementRows14 = await prisma.amazonAdsPlacementReport.count({ where: { placement: 'Top of Search on-Amazon', date: { gte: new Date(Date.now() - 14 * 86400000) } } })
  const nonNullIS = await prisma.amazonAdsPlacementReport.count({ where: { placement: 'Top of Search on-Amazon', date: { gte: new Date(Date.now() - 14 * 86400000) }, topOfSearchIS: { not: null } } })
  console.log(`TOP lane  (AmazonAdsPlacementReport 'Top of Search on-Amazon'): newest=${latestPlacement?.date.toISOString().slice(0, 10)} rows(14d)=${placementRows14} withTopOfSearchIS=${nonNullIS}`)

  const sqpLatest = await prisma.searchQueryPerformance.groupBy({ by: ['marketplace', 'startDate'], _count: { _all: true }, orderBy: { startDate: 'desc' }, take: 8 })
  console.log(`REST lane (SearchQueryPerformance) most recent weeks:`)
  for (const r of sqpLatest) console.log(`   ${r.marketplace} week ${r.startDate.toISOString().slice(0, 10)} rows=${r._count._all}  ageDays=${Math.round((Date.now() - +r.startDate) / 86400000)}`)

  console.log('\n=== E. SQP signal per live campaign (the REST-lane feedback), and WHY it is missing ===')
  const ads = await prisma.adProductAd.findMany({ where: { adGroup: { campaignId: { in: camps.map((c) => c.id) } }, status: 'ENABLED' }, select: { asin: true, adGroup: { select: { campaignId: true } } } })
  const asinsBy = new Map<string, Set<string>>()
  for (const a of ads) { const cid = a.adGroup?.campaignId; if (!cid || !a.asin) continue; const s = asinsBy.get(cid) ?? new Set(); s.add(a.asin); asinsBy.set(cid, s) }
  const seen = new Map<string, string>()
  for (const c of camps) {
    const asins = [...(asinsBy.get(c.id) ?? [])]
    const grp = groups.find((g) => g.id === scheds.find((s) => s.campaignId === c.id)?.groupId)?.name ?? '?'
    if (seen.has(grp)) continue
    const share = asins.length && c.marketplace ? await sqpImpressionShareForAsins(c.marketplace, asins) : null
    const inSqp = asins.length ? await prisma.searchQueryPerformance.count({ where: { asin: { in: asins } } }) : 0
    seen.set(grp, 'x')
    console.log(`  ${grp.padEnd(20)} mkt=${c.marketplace} asins=${asins.length} sqpShare=${share == null ? 'NULL (open loop)' : (share * 100).toFixed(2) + '%'} sqpRowsForTheseAsins(all time)=${inSqp}`)
  }

  await prisma.$disconnect()
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
