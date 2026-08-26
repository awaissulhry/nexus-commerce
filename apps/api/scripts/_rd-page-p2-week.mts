// RD-P2 → P1 — how much do the band's counts move across the week?
//
// The acceptance test is hour-dependent, so a band designed against ONE hour will look wrong at
// others. This runs the shipped derivation over all 168 hours and reports each cohort's range, so
// P1 designs against the spread rather than against noon on a Wednesday. Read-only, no .catch.
import '../src/env.js'
import prisma from '../src/db.js'
import { deriveCampaignRuntime, type RdCampaignRuntimeInput } from '../src/services/advertising/rank-runtime.js'
import type { ScheduleWindow } from '../src/services/advertising/rank-controller.js'

async function main() {
  const schedules = await prisma.adSchedule.findMany()
  const campIds = [...new Set(schedules.map((s) => s.campaignId))]
  const camps = await prisma.campaign.findMany({ where: { id: { in: campIds } }, select: { id: true, biddingStrategy: true } })
  const campById = new Map(camps.map((c) => [c.id, c]))
  const targets = await prisma.rankTarget.findMany()
  const targetByKey = new Map(targets.map((t) => [t.key, t as never]))

  const maxBaseBid = new Map<string, number>()
  const [agRows, agIndex] = await Promise.all([
    prisma.adGroup.groupBy({ by: ['campaignId'], where: { campaignId: { in: campIds } }, _max: { defaultBidCents: true, suppressedFromBidCents: true } }),
    prisma.adGroup.findMany({ where: { campaignId: { in: campIds } }, select: { id: true, campaignId: true } }),
  ])
  for (const r of agRows) { const v = Math.max(r._max.defaultBidCents ?? 0, r._max.suppressedFromBidCents ?? 0); if (v > 0) maxBaseBid.set(r.campaignId, v) }
  const byAg = new Map(agIndex.map((g) => [g.id, g.campaignId]))
  const tg = await prisma.adTarget.groupBy({ by: ['adGroupId'], where: { adGroup: { campaignId: { in: campIds } }, isNegative: false }, _max: { bidCents: true, suppressedFromBidCents: true } })
  for (const r of tg) { const cid = byAg.get(r.adGroupId); if (!cid) continue; const v = Math.max(r._max.bidCents ?? 0, r._max.suppressedFromBidCents ?? 0); if (v > (maxBaseBid.get(cid) ?? 0)) maxBaseBid.set(cid, v) }

  const kinds = ['holding', 'chasing', 'all-out', 'capped-base', 'capped-floor', 'min-bid', 'nothing-held', 'not-running'] as const
  const range: Record<string, { min: number; max: number; total: number }> = {}
  for (const k of kinds) range[k] = { min: 99, max: -1, total: 0 }
  const convergeRange = { min: 99, max: -1 }
  let hours = 0

  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      hours++
      const tally: Record<string, number> = {}
      let cannot = 0
      for (const s of schedules) {
        const c = campById.get(s.campaignId)
        const r = deriveCampaignRuntime({
          scheduleId: s.id, campaignId: s.campaignId, groupId: s.groupId,
          scheduleEnabled: s.enabled,
          windows: s.windows as ScheduleWindow[] | null,
          defaultTargetKey: s.defaultTargetKey,
          timezoneNow: { day, hour },
          event: null, targetByKey,
          targetOverrides: s.targetOverrides as never,
          maxBaseBidCents: maxBaseBid.get(s.campaignId) ?? null,
          biddingStrategy: c?.biddingStrategy ?? null,
          governed: false,
        } as RdCampaignRuntimeInput)
        tally[r.mode.kind] = (tally[r.mode.kind] ?? 0) + 1
        if (!r.canConverge) cannot++
      }
      for (const k of kinds) {
        const n = tally[k] ?? 0
        range[k].min = Math.min(range[k].min, n)
        range[k].max = Math.max(range[k].max, n)
        range[k].total += n
      }
      convergeRange.min = Math.min(convergeRange.min, cannot)
      convergeRange.max = Math.max(convergeRange.max, cannot)
    }
  }

  console.log(`=== COHORT RANGE ACROSS ${hours} HOURS (45 schedules, 33 live) ===`)
  console.log('cohort         min  max   mean   ← a band designed at one hour will be wrong at others')
  for (const k of kinds) {
    const r = range[k]
    console.log(`${k.padEnd(14)} ${String(r.min).padStart(3)}  ${String(r.max).padStart(3)}   ${(r.total / hours).toFixed(1).padStart(5)}`)
  }
  console.log(`cannot-converge ${String(convergeRange.min).padStart(2)}  ${String(convergeRange.max).padStart(3)}`)
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); return prisma.$disconnect().then(() => process.exit(1)) })
