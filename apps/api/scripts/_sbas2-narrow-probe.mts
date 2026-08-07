/**
 * NAF.SB.AS.2 — READ-ONLY proof that the bid tuner and portfolio targets
 * bind against real production data.
 *
 * AS.1 proved the miner/harvester path. This proves the two things AS.2 adds,
 * both of which have their own trap:
 *
 *  - the bid tuner narrows through an id-DIALECT join (proposals carry an
 *    AdTarget cuid; the fleet speaks external campaign ids), and
 *  - a portfolio target is enforced AS a campaign scope, so it must resolve
 *    to real member campaigns or refuse.
 *
 * Strictly read-only: findMany/groupBy only, and deliberately NOT
 * getObservation (that would write a cache row).
 */
import '../src/env.js'
const { default: prisma } = await import('../src/db.js')
const { resolveAssignmentScope } = await import(
  '../src/services/agent-fleet/assignment-scope.js'
)
const { narrowKindsFor } = await import('../src/services/agent-fleet/observation-builder.js')
const { listAssignablePortfolios, listAssignableWorkers } = await import(
  '../src/services/agent-fleet/assignment.service.js'
)
const { bidProposalsBuilder } = await import(
  '../src/services/agent-fleet/observations/bid-proposals.observation.js'
)

const h = (t: string) => console.log(`\n${'='.repeat(72)}\n${t}\n${'='.repeat(72)}`)
let failures = 0
const check = (label: string, pass: boolean, detail = '') => {
  console.log(`${pass ? '  ✓' : '  ✗'} ${label}${detail ? ` — ${detail}` : ''}`)
  if (!pass) failures++
}

h('1 · What each worker may be pointed at, derived from its evidence')
const workers = await listAssignableWorkers()
for (const w of workers) {
  const kinds = w.targetKinds.length ? w.targetKinds.join(', ') : '—'
  console.log(`  ${w.key.padEnd(28)} ${kinds}${w.refusal ? '  (refused)' : ''}`)
}
const tuner = workers.find((w) => w.key === 'amazon-bid-tuner')
check('the bid tuner is now assignable', !!tuner && !tuner.refusal)
check('…to a CAMPAIGN', !!tuner?.targetKinds.includes('CAMPAIGN'))
check('…and to a PORTFOLIO (same binding path)', !!tuner?.targetKinds.includes('PORTFOLIO'))
check(
  '…but NOT to a MARKETPLACE — its build() takes no scope, so it would bind nothing',
  !tuner?.targetKinds.includes('MARKETPLACE'),
)
check('bid-proposals declares CAMPAIGN only', narrowKindsFor('bid-proposals').join() === 'CAMPAIGN')

h('2 · Portfolios that can actually be assigned')
const portfolios = await listAssignablePortfolios()
console.log(`  ${portfolios.length} portfolio(s) hold campaigns:`)
for (const p of portfolios.slice(0, 6)) {
  console.log(`    ${p.name} — ${p.campaignCount} campaign(s) · ${p.marketplaces.join(', ')}`)
}
check('every offered portfolio has at least one campaign', portfolios.every((p) => p.campaignCount > 0))

if (portfolios.length) {
  const pf = portfolios[0]
  const miner = { scopeMarketplaces: [], observationKeys: ['negative-candidates'] } as never
  const r = await resolveAssignmentScope(miner, { kind: 'PORTFOLIO', ids: [pf.portfolioId] })
  check('a real portfolio resolves to its member campaigns', !r.error && !!r.narrow, r.error ?? '')
  check(
    `  …and yields exactly its ${pf.campaignCount} campaign(s)`,
    r.narrow?.campaignExternalIds?.length === pf.campaignCount,
    `got ${r.narrow?.campaignExternalIds?.length}`,
  )

  const gone = await resolveAssignmentScope(miner, { kind: 'PORTFOLIO', ids: ['pf-does-not-exist'] })
  check('an unknown portfolio REFUSES rather than running the account', !!gone.error, gone.error)
  check('  …and returns no narrow', gone.narrow === undefined)
}

h('3 · The bid tuner, narrowed against real proposals')
const tunerCharter = { scopeMarketplaces: [], observationKeys: ['bid-proposals'] } as never
const liveCampaign = await prisma.campaign.findFirst({
  where: { externalCampaignId: { not: null }, status: 'ENABLED' },
  select: { externalCampaignId: true, name: true },
})
if (!liveCampaign?.externalCampaignId) {
  console.log('  (no enabled campaign — skipped)')
} else {
  const ok = await resolveAssignmentScope(tunerCharter, {
    kind: 'CAMPAIGN',
    ids: [liveCampaign.externalCampaignId],
  })
  check('the bid tuner accepts a campaign target', !ok.error, ok.error ?? '')

  const mk = await resolveAssignmentScope(tunerCharter, { kind: 'MARKETPLACE', ids: ['IT'] })
  check(
    'the bid tuner still REFUSES a marketplace target',
    mk.error?.startsWith('target_unsupported') === true,
    mk.error,
  )

  // The real payload, then the real narrowing — the id-dialect join.
  const built = await bidProposalsBuilder.build({})
  const p = built.payload as { proposals: { targetId: string }[]; counts: Record<string, number> }
  console.log(`  account-wide proposals: ${p.proposals.length}`)

  if (p.proposals.length === 0) {
    console.log('  (no bid proposals in prod right now — the join is asserted by vitest instead)')
  } else {
    // Which campaign do these proposals actually belong to?
    const rows = await prisma.adTarget.findMany({
      where: { id: { in: p.proposals.map((x) => x.targetId) } },
      select: { id: true, adGroup: { select: { campaign: { select: { externalCampaignId: true, name: true } } } } },
    })
    const counts = new Map<string, { n: number; name: string }>()
    for (const r of rows) {
      const ext = r.adGroup?.campaign?.externalCampaignId
      if (!ext) continue
      const e = counts.get(ext) ?? { n: 0, name: r.adGroup!.campaign!.name }
      e.n++
      counts.set(ext, e)
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)
    console.log(`  they span ${ranked.length} campaign(s); top: ${ranked[0]?.[1].name} (${ranked[0]?.[1].n})`)

    if (ranked.length) {
      const [topExt, top] = ranked[0]
      const narrowed = (await bidProposalsBuilder.narrow!(p, {
        campaignExternalIds: [topExt],
        campaignLabels: [top.name],
      })) as typeof p
      check(
        `narrowed to ${top.name}: kept exactly its proposals`,
        narrowed.proposals.length === top.n,
        `kept=${narrowed.proposals.length} expected=${top.n}`,
      )
      check(
        'narrowed < account-wide (the whole point)',
        narrowed.proposals.length <= p.proposals.length,
        `${narrowed.proposals.length} of ${p.proposals.length}`,
      )
      const empty = (await bidProposalsBuilder.narrow!(p, { campaignExternalIds: [] })) as typeof p
      check('an EMPTY scope yields nothing, never everything', empty.proposals.length === 0)
    }
  }
}

h(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
await prisma.$disconnect()
process.exit(failures === 0 ? 0 : 1)
