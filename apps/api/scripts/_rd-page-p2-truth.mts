// RD-P2 — re-measure §5 by running the ENGINE'S OWN functions over every campaign, right now.
//
// The brief says re-measure and do not assume. This does not re-implement the derivation: it calls
// resolveActiveTargetKey / applyTargetOverrides / biasBand / cpcCapPct / strategyHeadroom, i.e. the
// exact path `runRankDefendOnce` takes for the 45 AdSchedule rows (job lines 663-681).
//
// Deliberately NO .catch(() => []) around any measurement — a swallowed error reads exactly like a
// zero, and this programme has published three wrong conclusions that way.
import '../src/env.js'
import prisma from '../src/db.js'
import {
  resolveActiveTargetKey, biasBand, cpcCapPct, strategyHeadroom,
  type RankTargetSpec, type ScheduleWindow, type LaneSpec,
} from '../src/services/advertising/rank-controller.js'
import { applyTargetOverrides, pickActiveEvents, isGoalMode } from '../src/jobs/ad-rank-defend.job.js'

// PROBE-ONLY copy of the job's unexported `toSpec` (job:58). The shipped module will export the
// engine's rather than carry a second copy — a duplicate here only has to survive this one run.
const toSpec = (t: Record<string, unknown>): RankTargetSpec => ({
  key: t.key as string, placement: t.placement as string,
  targetISPct: t.targetISPct as number | null, acosCapPct: t.acosCapPct as number | null,
  maxCpcCents: t.maxCpcCents as number | null, biasPct: t.biasPct as number | null,
  pause: t.pause as boolean, floorBidCents: (t.floorBidCents ?? null) as number | null,
  allOut: t.allOut as boolean, jumpStartPct: (t.jumpStartPct ?? null) as number | null,
  stepUpPct: (t.stepUpPct ?? null) as number | null, stepDownPct: (t.stepDownPct ?? null) as number | null,
  maxBiasPct: (t.maxBiasPct ?? null) as number | null, keepClimbing: !!t.keepClimbing,
  lanes: Array.isArray(t.lanes) ? (t.lanes as LaneSpec[]) : null,
  bidMode: (t.bidMode ?? null) as string | null, bidValueCents: (t.bidValueCents ?? null) as number | null,
  bidDeltaPct: (t.bidDeltaPct ?? null) as number | null,
})

const nowInTz = (tz: string, baseNow: Date) => {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(baseNow)
  const wk = parts.find((p) => p.type === 'weekday')?.value ?? 'Sun'
  const dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wk)
  let hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10) % 24
  if (Number.isNaN(hour)) hour = 0
  return { day: dayIdx < 0 ? 0 : dayIdx, hour }
}

async function main() {
  // ── the clock, both of them ───────────────────────────────────────────────────────────────
  const rows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() as now`
  const dbNow = rows[0].now instanceof Date ? rows[0].now : new Date(rows[0].now as unknown as string)
  const procNow = new Date()
  const skewMin = Math.round((procNow.getTime() - dbNow.getTime()) / 60000)
  console.log(`=== 0. CLOCK ===`)
  console.log(`db=${dbNow.toISOString()} · process=${procNow.toISOString()} · skew=${skewMin} min`)
  console.log(`engine resolves windows on the DB clock; /rank-schedule-groups uses the PROCESS clock`)
  console.log(`Rome now (db):   ${JSON.stringify(nowInTz('Europe/Rome', dbNow))}`)
  console.log(`Rome now (proc): ${JSON.stringify(nowInTz('Europe/Rome', procNow))}`)

  const schedules = await prisma.adSchedule.findMany()
  const campIds = [...new Set(schedules.map((s) => s.campaignId))]
  const camps = await prisma.campaign.findMany({
    where: { id: { in: campIds } },
    select: { id: true, name: true, marketplace: true, portfolioId: true, status: true, biddingStrategy: true },
  })
  const campById = new Map(camps.map((c) => [c.id, c]))
  const targets = await prisma.rankTarget.findMany()
  const targetByKey = new Map(targets.map((t) => [t.key, t as unknown as Record<string, unknown>]))
  const groups = await prisma.rankScheduleGroup.findMany()
  const groupById = new Map(groups.map((g) => [g.id, g]))

  // ── events: the engine loads them and they OVERRIDE the plan ──────────────────────────────
  const evRows = await prisma.rankScheduleEvent.findMany({ where: { enabled: true } })
  const activeEvents = pickActiveEvents(evRows.map((e) => ({ ...e, enabled: true })) as never, dbNow)
  console.log(`\n=== 1. EVENTS === enabled=${evRows.length} · active now=${activeEvents.size}`)

  // ── governed elsewhere: ProductRankPlan wins, the schedule loop SKIPS those campaigns ──────
  const plans = await prisma.productRankPlan.findMany({ where: { enabled: true }, select: { lastSummary: true } })
  const governed = new Set<string>()
  for (const p of plans) {
    const decs = (p.lastSummary as { decisions?: Array<{ campaignId?: string }> } | null)?.decisions
    for (const d of decs ?? []) if (d?.campaignId) governed.add(d.campaignId)
  }
  console.log(`=== 2. GOVERNED ELSEWHERE === enabled plans=${plans.length} · campaigns skipped=${governed.size}`)

  // ── max live base bid per campaign — the groupBy shape at job:534-551 ──────────────────────
  const maxBaseBid = new Map<string, number>()
  const [agRows, agIndex] = await Promise.all([
    prisma.adGroup.groupBy({ by: ['campaignId'], where: { campaignId: { in: campIds } }, _max: { defaultBidCents: true, suppressedFromBidCents: true } }),
    prisma.adGroup.findMany({ where: { campaignId: { in: campIds } }, select: { id: true, campaignId: true } }),
  ])
  for (const r of agRows) {
    const v = Math.max(r._max.defaultBidCents ?? 0, r._max.suppressedFromBidCents ?? 0)
    if (v > 0) maxBaseBid.set(r.campaignId, v)
  }
  const campByAdGroup = new Map(agIndex.map((g) => [g.id, g.campaignId]))
  const tgRows = await prisma.adTarget.groupBy({ by: ['adGroupId'], where: { adGroup: { campaignId: { in: campIds } }, isNegative: false }, _max: { bidCents: true, suppressedFromBidCents: true } })
  for (const r of tgRows) {
    const cid = campByAdGroup.get(r.adGroupId); if (!cid) continue
    const v = Math.max(r._max.bidCents ?? 0, r._max.suppressedFromBidCents ?? 0)
    if (v > (maxBaseBid.get(cid) ?? 0)) maxBaseBid.set(cid, v)
  }
  console.log(`=== 3. MAX BASE BID === resolved for ${maxBaseBid.size}/${campIds.length} campaigns`)

  // ── the derivation, per campaign ───────────────────────────────────────────────────────────
  const tally = { notRunning: 0, governed: 0, noWindow: 0, dangling: 0, pause: 0, baseAlone: 0, cappedBelowFloor: 0, cappedAbove: 0, chasing: 0, holding: 0 }
  const lanes: Record<string, number> = {}
  const detail: string[] = []

  for (const s of schedules) {
    const c = campById.get(s.campaignId)
    const label = `${(c?.name ?? s.campaignId).slice(0, 34).padEnd(34)}`
    const goalMode = isGoalMode(s.windows, s.defaultTargetKey)
    if (!s.enabled || !goalMode) { tally.notRunning++; detail.push(`${label} | NOT RUNNING (enabled=${s.enabled} goalMode=${goalMode})`); continue }
    if (governed.has(s.campaignId)) { tally.governed++; detail.push(`${label} | GOVERNED ELSEWHERE`); continue }

    const { day, hour } = nowInTz(s.timezone || 'Europe/Rome', dbNow)
    const ev = s.groupId ? activeEvents.get(s.groupId) : undefined
    const planWindows = (ev ? (ev as never as { windows: unknown }).windows : s.windows) as ScheduleWindow[]
    const planBaseline = ev ? (ev as never as { defaultTargetKey: string | null }).defaultTargetKey : s.defaultTargetKey
    const key = resolveActiveTargetKey(planWindows, planBaseline, day, hour)
    if (!key) { tally.noWindow++; detail.push(`${label} | NOTHING HELD (no window, no baseline)`); continue }
    const t = targetByKey.get(key)
    if (!t) { tally.dangling++; detail.push(`${label} | DANGLING TARGET ${key}`); continue }

    const spec = applyTargetOverrides(toSpec(t), s.targetOverrides as never)
    const { floor, ceiling } = biasBand(spec)
    const canChase = spec.allOut || ceiling > floor
    const cap = cpcCapPct(spec.maxCpcCents, maxBaseBid.get(s.campaignId) ?? null, strategyHeadroom(c?.biddingStrategy))
    lanes[spec.placement] = (lanes[spec.placement] ?? 0) + 1

    let mode: string
    if (spec.pause) { mode = `Min bid €${((spec.floorBidCents ?? 2) / 100).toFixed(2)}`; tally.pause++ }
    else if (cap?.baseAlone) { mode = `Capped 0% (baseAlone, base €${((maxBaseBid.get(s.campaignId) ?? 0) / 100).toFixed(2)} > ceiling €${((spec.maxCpcCents ?? 0) / 100).toFixed(2)})`; tally.baseAlone++ }
    else if (cap && cap.capPct < floor) { mode = `Capped ${cap.capPct}% (< floor ${floor}%)`; tally.cappedBelowFloor++ }
    else if (canChase) { mode = `Chasing ${spec.targetISPct ?? '—'}% IS (band ${floor}-${ceiling})`; tally.chasing++ }
    else { mode = `Holding ${floor}%`; tally.holding++ }
    if (cap && !cap.baseAlone && cap.capPct >= floor) tally.cappedAbove++

    detail.push(`${label} | ${key.padEnd(15)} | ${spec.placement.padEnd(26)} | band ${String(floor).padStart(3)}-${String(ceiling).padStart(3)} | chase=${canChase ? 'Y' : 'N'} | cap=${cap ? `${cap.capPct}%${cap.baseAlone ? ' BASEALONE' : ''}` : '—'} | ${mode}`)
  }

  console.log(`\n=== 4. PER-CAMPAIGN (${schedules.length} rows) ===`)
  for (const d of detail) console.log('  ' + d)
  console.log(`\n=== 5. COHORTS (the acceptance test) ===`)
  console.log(JSON.stringify(tally, null, 1))
  console.log(`lanes active right now: ${JSON.stringify(lanes)}`)
  const openLoop = tally.holding + tally.pause + tally.baseAlone + tally.cappedBelowFloor
  console.log(`open-loop (cannot chase, any reason) = ${openLoop} · chasing = ${tally.chasing}`)
  console.log(`capped in any form = ${tally.baseAlone + tally.cappedBelowFloor + tally.cappedAbove}`)

  // ── signal availability per lane ───────────────────────────────────────────────────────────
  console.log(`\n=== 6. SIGNAL SOURCES ===`)
  const mkts = [...new Set(camps.map((c) => c.marketplace).filter(Boolean) as string[])]
  console.log(`markets across rank-controlled campaigns: ${mkts.join(', ')}`)
  const { analyzeTopOfSearch } = await import('../src/services/advertising/ads-top-of-search.service.js')
  for (const m of mkts) {
    const tos = await analyzeTopOfSearch({ marketplace: m })
    const withIS = tos.rows.filter((r) => (r as { topOfSearchIS?: number | null }).topOfSearchIS != null).length
    console.log(`  Top-IS ${m}: ${tos.rows.length} rows, ${withIS} carry topOfSearchIS (windowDays=${tos.windowDays})`)
  }
  const sqpTotal = await prisma.searchQueryPerformance.count()
  console.log(`  SQP rows all-time: ${sqpTotal}`)
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => { console.error(e); return prisma.$disconnect().then(() => process.exit(1)) })
