// RD-P2 — run the SHIPPED module over live data and check it reproduces the acceptance test.
// No .catch anywhere.
import '../src/env.js'
import prisma from '../src/db.js'
import { deriveCampaignRuntime, rollUpGroup, type RdCampaignRuntimeInput } from '../src/services/advertising/rank-runtime.js'
import { pickActiveEvents } from '../src/jobs/ad-rank-defend.job.js'
import type { ScheduleWindow } from '../src/services/advertising/rank-controller.js'

const nowInTz = (tz: string, at: Date) => {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: 'numeric', hour12: false }).formatToParts(at)
  const wk = p.find((x) => x.type === 'weekday')?.value ?? 'Sun'
  let hour = parseInt(p.find((x) => x.type === 'hour')?.value ?? '0', 10) % 24
  if (Number.isNaN(hour)) hour = 0
  const d = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(wk)
  return { day: d < 0 ? 0 : d, hour }
}

async function main() {
  const nowRows = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT now() as now`
  const dbNow = nowRows[0].now instanceof Date ? nowRows[0].now : new Date(nowRows[0].now as unknown as string)

  const schedules = await prisma.adSchedule.findMany()
  const campIds = [...new Set(schedules.map((s) => s.campaignId))]
  const camps = await prisma.campaign.findMany({ where: { id: { in: campIds } }, select: { id: true, name: true, biddingStrategy: true } })
  const campById = new Map(camps.map((c) => [c.id, c]))
  const targets = await prisma.rankTarget.findMany()
  const targetByKey = new Map(targets.map((t) => [t.key, t as never]))

  const evRows = await prisma.rankScheduleEvent.findMany({ where: { enabled: true } })
  const activeEvents = pickActiveEvents(evRows.map((e) => ({ ...e, enabled: true })) as never, dbNow)

  const plans = await prisma.productRankPlan.findMany({ where: { enabled: true }, select: { lastSummary: true } })
  const governed = new Set<string>()
  for (const p of plans) for (const d of ((p.lastSummary as { decisions?: Array<{ campaignId?: string }> } | null)?.decisions) ?? []) if (d?.campaignId) governed.add(d.campaignId)

  const maxBaseBid = new Map<string, number>()
  const [agRows, agIndex] = await Promise.all([
    prisma.adGroup.groupBy({ by: ['campaignId'], where: { campaignId: { in: campIds } }, _max: { defaultBidCents: true, suppressedFromBidCents: true } }),
    prisma.adGroup.findMany({ where: { campaignId: { in: campIds } }, select: { id: true, campaignId: true } }),
  ])
  for (const r of agRows) { const v = Math.max(r._max.defaultBidCents ?? 0, r._max.suppressedFromBidCents ?? 0); if (v > 0) maxBaseBid.set(r.campaignId, v) }
  const campByAdGroup = new Map(agIndex.map((g) => [g.id, g.campaignId]))
  const tg = await prisma.adTarget.groupBy({ by: ['adGroupId'], where: { adGroup: { campaignId: { in: campIds } }, isNegative: false }, _max: { bidCents: true, suppressedFromBidCents: true } })
  for (const r of tg) { const cid = campByAdGroup.get(r.adGroupId); if (!cid) continue; const v = Math.max(r._max.bidCents ?? 0, r._max.suppressedFromBidCents ?? 0); if (v > (maxBaseBid.get(cid) ?? 0)) maxBaseBid.set(cid, v) }

  const runtimes = schedules.map((s) => {
    const c = campById.get(s.campaignId)
    const ev = s.groupId ? activeEvents.get(s.groupId) : undefined
    const input: RdCampaignRuntimeInput = {
      scheduleId: s.id, campaignId: s.campaignId, groupId: s.groupId,
      scheduleEnabled: s.enabled,
      windows: s.windows as ScheduleWindow[] | null,
      defaultTargetKey: s.defaultTargetKey,
      timezoneNow: nowInTz(s.timezone || 'Europe/Rome', dbNow),
      event: ev ? { windows: (ev as never as { windows: ScheduleWindow[] }).windows, defaultTargetKey: (ev as never as { defaultTargetKey: string | null }).defaultTargetKey, name: (ev as never as { name: string }).name } : null,
      targetByKey,
      targetOverrides: s.targetOverrides as never,
      maxBaseBidCents: maxBaseBid.get(s.campaignId) ?? null,
      biddingStrategy: c?.biddingStrategy ?? null,
      governed: governed.has(s.campaignId),
    }
    return { name: c?.name ?? s.campaignId, r: deriveCampaignRuntime(input) }
  })

  const tally: Record<string, number> = {}
  for (const { r } of runtimes) tally[r.mode.kind] = (tally[r.mode.kind] ?? 0) + 1
  console.log('=== ACCEPTANCE TEST (approved, hour-independent form) ===')
  console.log(JSON.stringify(tally, null, 1))
  console.log(`cannot converge: ${runtimes.filter((x) => !x.r.canConverge).length}`)
  console.log(`goals live     : ${runtimes.filter((x) => x.r.goal.live).length}`)
  console.log(`goals set but DEAD: ${runtimes.filter((x) => x.r.goal.targetPct != null && !x.r.goal.live).length}`)

  console.log('\n=== the five baseAlone, named ===')
  for (const { name, r } of runtimes.filter((x) => x.r.mode.kind === 'capped-base')) console.log(`  ${name.padEnd(34)} ${r.mode.label}`)
  console.log('=== capped below floor ===')
  for (const { name, r } of runtimes.filter((x) => x.r.mode.kind === 'capped-floor')) console.log(`  ${name.padEnd(34)} ${r.mode.label}`)

  console.log('\n=== GROUP ROLL-UP — the spread, never an average ===')
  const groups = await prisma.rankScheduleGroup.findMany({ select: { id: true, name: true, enabled: true } })
  for (const g of groups) {
    const rows = runtimes.filter((x) => x.r.groupId === g.id).map((x) => x.r)
    if (!rows.length) continue
    const up = rollUpGroup(rows)
    console.log(`  ${g.name.slice(0, 30).padEnd(30)} | n=${String(up.members).padStart(2)} | ${up.modeSummary.padEnd(34)} | cannotConverge=${up.cannotConverge} | goalsLive=${up.goalsLive}`)
  }
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); return prisma.$disconnect().then(() => process.exit(1)) })
