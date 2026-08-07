/**
 * NAF.SB.AS / AS.1 — READ-ONLY proof that campaign narrowing actually binds.
 *
 * The claim this page rests on is that a target narrows the EVIDENCE, not a
 * prompt. This probe proves it against production data, and proves the
 * fail-closed rules that stop a stale target from silently widening to the
 * whole account.
 *
 * Strictly read-only: previewHarvest is a groupBy, resolveAssignmentScope is
 * one findMany, filterToCampaigns is pure. No create/update/upsert/delete,
 * and deliberately NOT getObservation — that would write a cache row.
 *
 * Env trap (reference_scripts_env_trap): env.js FIRST, db.js dynamic.
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { previewHarvest } = await import('../src/services/advertising/ads-harvest.service.js')
const { filterToCampaigns } = await import(
  '../src/services/agent-fleet/observations/scope-filter.js'
)
const { resolveAssignmentScope } = await import(
  '../src/services/agent-fleet/assignment-scope.js'
)

const h = (t: string) => console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`)
let failures = 0
const check = (label: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

h('1 · The real evidence, account-wide')
const preview = await previewHarvest({})
console.log(`  negatives=${preview.negatives.length} graduations=${preview.graduations.length} window=${preview.windowDays}d`)

const byCampaign = new Map<string, number>()
for (const n of preview.negatives) {
  byCampaign.set(n.externalCampaignId, (byCampaign.get(n.externalCampaignId) ?? 0) + 1)
}
const ranked = [...byCampaign.entries()].sort((a, b) => b[1] - a[1])
console.log(`  candidates span ${ranked.length} campaign(s); top:`, ranked.slice(0, 3))

h('2 · filterToCampaigns narrows to exactly what was named')
if (ranked.length === 0) {
  console.log('  (no negative candidates in prod right now — filter logic still asserted below)')
} else {
  const [topId, topCount] = ranked[0]
  const camp = await prisma.campaign.findFirst({
    where: { externalCampaignId: topId },
    select: { name: true, marketplace: true },
  })
  console.log(`  narrowing to ${camp?.name ?? topId} (${camp?.marketplace ?? '?'})`)
  const r = filterToCampaigns(preview.negatives, [topId])
  check('kept exactly the named campaign\'s candidates', r.kept.length === topCount,
    `kept=${r.kept.length} expected=${topCount}`)
  check('every kept row really belongs to that campaign',
    r.kept.every((x) => x.externalCampaignId === topId))
  check('narrowed < account-wide (the whole point)',
    r.kept.length < preview.negatives.length,
    `${r.kept.length} of ${preview.negatives.length}`)
  check('drops are counted, never silent',
    r.kept.length + r.droppedOutOfScope + r.unresolved === preview.negatives.length,
    `${r.kept.length}+${r.droppedOutOfScope}+${r.unresolved}`)
}

h('3 · FAIL CLOSED — the bug that would run the miner over all 220 campaigns')
const empty = filterToCampaigns(preview.negatives, [])
check('an empty scope yields NOTHING, never everything', empty.kept.length === 0,
  `kept=${empty.kept.length}`)
const undef = filterToCampaigns(preview.negatives, undefined)
check('undefined is the ONLY value that means everything',
  undef.kept.length === preview.negatives.length)
const bogus = filterToCampaigns(preview.negatives, ['this-campaign-does-not-exist'])
check('an unknown campaign yields nothing', bogus.kept.length === 0)

h('4 · resolveAssignmentScope against real campaigns')
const live = await prisma.campaign.findFirst({
  where: { externalCampaignId: { not: null }, status: 'ENABLED' },
  select: { externalCampaignId: true, name: true, marketplace: true },
})
if (!live?.externalCampaignId) {
  console.log('  (no enabled campaign with an external id — skipped)')
} else {
  console.log(`  using ${live.name} (${live.marketplace}) ext=${live.externalCampaignId}`)
  const miner = { scopeMarketplaces: [], observationKeys: ['negative-candidates'] } as never

  const ok = await resolveAssignmentScope(miner, {
    kind: 'CAMPAIGN',
    ids: [live.externalCampaignId],
  })
  check('a live campaign resolves to a narrow', !ok.error && !!ok.narrow?.campaignExternalIds,
    ok.error ?? `ids=${ok.narrow?.campaignExternalIds?.length}`)
  check('and carries its frozen label', !!ok.narrow?.campaignLabels?.length,
    ok.narrow?.campaignLabels?.[0])

  const gone = await resolveAssignmentScope(miner, { kind: 'CAMPAIGN', ids: ['000000000000000'] })
  check('an archived/gone campaign STOPS the run', gone.error?.startsWith('target_gone') === true,
    gone.error)
  check('  …and returns no narrow (never account-wide)', gone.narrow === undefined)

  const none = await resolveAssignmentScope(miner, { kind: 'CAMPAIGN', ids: [] })
  check('an empty target is refused', !!none.error, none.error)

  // The widening guard, with the worker limited to the OTHER marketplace.
  const other = live.marketplace === 'IT' ? 'DE' : 'IT'
  const widen = await resolveAssignmentScope(
    { scopeMarketplaces: [other], observationKeys: ['negative-candidates'] } as never,
    { kind: 'CAMPAIGN', ids: [live.externalCampaignId] },
  )
  check(`a ${other}-limited worker cannot be pointed at a ${live.marketplace} campaign`,
    widen.error?.startsWith('target_outside_worker_scope') === true, widen.error)

  const tuner = { scopeMarketplaces: [], observationKeys: ['bid-proposals'] } as never
  const unsup = await resolveAssignmentScope(tuner, {
    kind: 'CAMPAIGN',
    ids: [live.externalCampaignId],
  })
  check('a worker whose evidence cannot narrow is refused, not half-scoped',
    unsup.error?.startsWith('target_unsupported') === true, unsup.error)
}

h('5 · The AgentAssignment table')
try {
  const n = await prisma.agentAssignment.count()
  console.log(`  AgentAssignment rows: ${n} (table exists — migration applied)`)
} catch (e) {
  console.log(`  table not present yet: ${String(e).slice(0, 120)}`)
}
const stamped = await prisma.agentRun.count({ where: { assignmentId: { not: null } } })
console.log(`  AgentRun rows stamped with an assignmentId: ${stamped}`)

h(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
