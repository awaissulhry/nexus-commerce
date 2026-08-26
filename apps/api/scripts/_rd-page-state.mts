// RD page study — the state the LIST PAGE must render. Read-only.
// Deliberately NO .catch(() => []) anywhere: a swallowed error reads exactly like a zero.
import '../src/env.js'
import prisma from '../src/db.js'

const j = (o: unknown) => JSON.stringify(o)

async function main() {
  console.log('=== 1. RankTarget library — THE FULL MOTION PROFILE ===')
  const targets = await prisma.rankTarget.findMany({ orderBy: { sortOrder: 'asc' } })
  for (const t of targets) {
    console.log([
      `key=${t.key}`, `place=${t.placement}`, `IS=${t.targetISPct}`, `acosCap=${t.acosCapPct}`,
      `maxCpc=${t.maxCpcCents}`, `bias(floor)=${t.biasPct}`, `maxBias(ceiling)=${t.maxBiasPct}`,
      `stepUp=${t.stepUpPct}`, `stepDown=${t.stepDownPct}`, `jumpStart=${t.jumpStartPct}`,
      `keepClimbing=${t.keepClimbing}`, `allOut=${t.allOut}`, `pause=${t.pause}`,
      `floorBid=${t.floorBidCents}`, `lanes=${t.lanes ? j(t.lanes) : 'null'}`,
      `bidMode=${t.bidMode}`, `bidVal=${t.bidValueCents}`, `bidDelta=${t.bidDeltaPct}`,
      `builtIn=${t.builtIn}`, `scopeProduct=${t.scopeProductId}`, `scopeCampaign=${t.scopeCampaignId}`,
    ].join(' | '))
  }

  console.log('\n=== 2. Groups ===')
  const groups = await prisma.rankScheduleGroup.findMany({ orderBy: { createdAt: 'asc' } })
  for (const g of groups) {
    const n = await prisma.adSchedule.count({ where: { groupId: g.id } })
    const wins = Array.isArray(g.windows) ? (g.windows as Array<Record<string, unknown>>) : []
    const ovr = g.targetOverrides as Record<string, unknown> | null
    console.log(`${g.enabled ? 'ON ' : 'off'} | ${g.name} | mkt=${g.marketplace} | tz=${g.timezone} | members=${n} | windows=${wins.length} | baseline=${g.defaultTargetKey} | pf=${g.portfolioId} | overrides=${ovr && Object.keys(ovr).length ? j(ovr).slice(0, 300) : '{}'} | created=${g.createdAt.toISOString().slice(0, 10)} | updated=${g.updatedAt.toISOString().slice(0, 10)}`)
  }

  console.log('\n=== 3. Governance objects — VERIFYING THE ZEROS (no catch) ===')
  const [vCount, eCount, tplCount, planCount] = await Promise.all([
    prisma.rankScheduleVersion.count(),
    prisma.rankScheduleEvent.count(),
    prisma.rankScheduleTemplate.count(),
    prisma.productRankPlan.count(),
  ])
  console.log(`RankScheduleVersion=${vCount}  RankScheduleEvent=${eCount}  RankScheduleTemplate=${tplCount}  ProductRankPlan=${planCount}`)
  const plans = await prisma.productRankPlan.findMany()
  for (const p of plans) console.log(`  plan: id=${p.id} product=${p.productId} mkt=${p.marketplace} enabled=${p.enabled} baseline=${p.defaultTargetKey} lastEval=${p.lastEvaluatedAt?.toISOString() ?? 'never'}`)

  console.log('\n=== 4. AdSchedule execution rows ===')
  const rows = await prisma.adSchedule.findMany()
  const goal = rows.filter((r) => !!r.defaultTargetKey || (Array.isArray(r.windows) && (r.windows as Array<{ targetKey?: string }>).some((w) => w?.targetKey)))
  const classic = rows.filter((r) => !goal.includes(r))
  console.log(`total=${rows.length} enabled=${rows.filter((r) => r.enabled).length} goalMode=${goal.length} classicMode=${classic.length} orphans(no group)=${rows.filter((r) => !r.groupId).length}`)
  const byApplied = new Map<string, number>()
  for (const r of rows) byApplied.set(String(r.lastApplied), (byApplied.get(String(r.lastApplied)) ?? 0) + 1)
  console.log('lastApplied:', j(Object.fromEntries(byApplied)))
  const lastEval = rows.map((r) => r.lastEvaluatedAt).filter(Boolean).sort((a, b) => +b! - +a!)
  console.log(`lastEvaluatedAt: newest=${lastEval[0]?.toISOString()} oldest=${lastEval[lastEval.length - 1]?.toISOString()} neverEvaluated=${rows.length - lastEval.length}`)
  const withOvr = rows.filter((r) => r.targetOverrides && Object.keys(r.targetOverrides as object).length)
  console.log(`\nrows with per-campaign targetOverrides = ${withOvr.length}`)
  for (const r of withOvr) console.log(`  ${r.name} :: ${j(r.targetOverrides)}`)
  if (classic.length) for (const r of classic) console.log(`  CLASSIC: ${r.name} enabled=${r.enabled} windows=${j(r.windows).slice(0, 200)}`)

  await prisma.$disconnect()
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1) })
