// RD-P4 → SQP — is the IS branch REALLY unreachable?
//
// SQP.2 §18.1 measured "campaigns where the IS branch is reachable: 0. Where it is not: 45", and
// concluded the reader is not the critical path. That was measured at ONE moment. This page's
// derivation is hour-resolved, so the same question over all 168 hours of the week may answer
// differently — and if it does, the SQP programme is sizing a guard against the wrong reachability.
//
// The IS branch in `computeStep` is reached only when, in order: not pause, not below floor,
// canChase, NOT allOut, no loss, and targetISPct != null. That is exactly this page's `chasing`
// mode. No .catch anywhere.
import '../src/env.js'
import prisma from '../src/db.js'
import { deriveCampaignRuntime, type RdCampaignRuntimeInput } from '../src/services/advertising/rank-runtime.js'
import type { ScheduleWindow } from '../src/services/advertising/rank-controller.js'

async function main() {
  const schedules = await prisma.adSchedule.findMany()
  const campIds = [...new Set(schedules.map((s) => s.campaignId))]
  const camps = await prisma.campaign.findMany({ where: { id: { in: campIds } }, select: { id: true, name: true, biddingStrategy: true } })
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

  // (campaign, hour) pairs where the IS branch is reachable
  const hoursByCampaign = new Map<string, number>()
  const lanesByCampaign = new Map<string, Set<string>>()
  let reachablePairs = 0
  const totalPairs = schedules.length * 168

  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
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
        // `chasing` IS the IS branch: canChase, not allOut, not pause, not capped below floor,
        // and a targetISPct present.
        if (r.mode.kind === 'chasing') {
          reachablePairs++
          hoursByCampaign.set(s.campaignId, (hoursByCampaign.get(s.campaignId) ?? 0) + 1)
          const set = lanesByCampaign.get(s.campaignId) ?? new Set<string>()
          if (r.placement) set.add(r.placement)
          lanesByCampaign.set(s.campaignId, set)
        }
      }
    }
  }

  console.log('=== IS BRANCH REACHABILITY over the whole week ===')
  console.log(`schedules=${schedules.length} · (campaign,hour) pairs=${totalPairs}`)
  console.log(`pairs where the IS branch is REACHABLE: ${reachablePairs} (${((reachablePairs / totalPairs) * 100).toFixed(2)}%)`)
  console.log(`campaigns that reach it at SOME hour: ${hoursByCampaign.size} of ${schedules.length}`)
  console.log('')
  for (const [cid, n] of [...hoursByCampaign.entries()].sort((a, b) => b[1] - a[1])) {
    const lanes = [...(lanesByCampaign.get(cid) ?? [])].join(',')
    console.log(`  ${(campById.get(cid)?.name ?? cid).padEnd(34)} ${String(n).padStart(3)}h/168  lane=${lanes}`)
  }
  if (hoursByCampaign.size === 0) console.log('  (none — SQP.2 §18.1 holds at every hour)')

  console.log('\n=== which lane would those hours read? ===')
  const all = new Set<string>()
  for (const s of lanesByCampaign.values()) for (const l of s) all.add(l)
  console.log(`  lanes: ${[...all].join(', ') || '(none)'}`)
  console.log('  PLACEMENT_TOP reads Amazon Top-of-Search IS; PLACEMENT_REST_OF_SEARCH reads SQP.')
}

main().then(() => prisma.$disconnect()).catch((e) => { console.error(e); return prisma.$disconnect().then(() => process.exit(1)) })
