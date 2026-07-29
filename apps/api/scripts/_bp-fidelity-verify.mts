// AX3.0 verification — READ-ONLY. Extracts a live structure and plans a
// replication onto a throwaway token, then reports exactly what the apply loop
// would now create versus what it would have created before.
// No writes, no Amazon calls: extractBlueprint/planApplication are pure and
// loadSourceCampaigns only reads.
//
//   npx tsx scripts/_bp-fidelity-verify.mts                  → the default set
//   npx tsx scripts/_bp-fidelity-verify.mts <portfolioId> <token>
const { loadSourceCampaigns } = await import('../src/services/advertising/ads-blueprint.service.js')
const { extractBlueprint } = await import('../src/services/ads-core/ads-blueprint.js')
const { planApplication } = await import('../src/services/ads-core/ads-blueprint-apply.js')
const { loadExistingTargets, loadExistingCampaignNames, marketContext } = await import('../src/services/advertising/ads-blueprint-apply.service.js')
const prisma = (await import('../src/db.js')).default
const L = (s = '') => console.log(s)

type Case = { label: string; portfolioId?: string; nameContains?: string; token: string; market: string }
const DEFAULTS: Case[] = [
  { label: 'IT AIREON (the convention-clean template)', portfolioId: '190601227863497', token: 'AIREON', market: 'IT' },
  { label: 'IT_Gale (underscore convention, has PRODUCT targets)', portfolioId: '182512333091276', token: 'GALE', market: 'IT' },
  { label: 'Xavia GALE IT (pipe convention)', portfolioId: '255127157311072', token: 'GALE', market: 'IT' },
  { label: 'Moss_Jacket (token at the END of the name)', portfolioId: '181885525106359', token: 'MOSS', market: 'IT' },
  { label: 'GALE product-targeting campaigns (NO portfolio)', nameContains: 'PRODUCT TARGETING', token: 'GALE', market: 'IT' },
]
const argv = process.argv.slice(2)
const cases: Case[] = argv.length >= 2 ? [{ label: `portfolio ${argv[0]}`, portfolioId: argv[0], token: argv[1]!, market: argv[2] ?? 'IT' }] : DEFAULTS

const ctx = new Map<string, { existing: Awaited<ReturnType<typeof loadExistingTargets>>; names: string[]; market: Awaited<ReturnType<typeof marketContext>> }>()
const ctxFor = async (mk: string) => {
  if (!ctx.has(mk)) {
    const [existing, names, market] = await Promise.all([loadExistingTargets(mk), loadExistingCampaignNames(mk), marketContext(mk)])
    ctx.set(mk, { existing, names, market })
  }
  return ctx.get(mk)!
}

type T = { kind: string; expressionType: string; isNegative: boolean; autoClause?: string | null }
const mt = (t: T) => (t.expressionType ?? 'EXACT').toUpperCase().replace(/^_/, '')
const isKw = (t: T) => t.kind?.toUpperCase() === 'KEYWORD'

for (const c of cases) {
  const where = c.portfolioId
    ? { portfolioId: c.portfolioId }
    : { name: { contains: c.nameContains!, mode: 'insensitive' as const }, status: { not: 'ARCHIVED' as const } }
  const rows = await prisma.campaign.findMany({ where, select: { id: true } })
  if (!rows.length) { L(`\n▁▁ ${c.label} — no campaigns matched, skipped`); continue }
  const { campaigns } = await loadSourceCampaigns({ campaignIds: rows.map((r) => r.id), marketplace: c.market })
  const doc = extractBlueprint(campaigns, { productToken: c.token })

  L(`\n▁▁ ${c.label}`)
  L(`   source ${campaigns.length} campaigns · ${doc.stats.adGroups} ad groups · ${doc.stats.positives} positives · ${doc.stats.negatives} negatives`)
  L(`   roles: ${doc.campaigns.map((x) => x.role).join(', ').slice(0, 150)}`)
  L(`   targetingType: ${doc.campaigns.filter((x) => x.targetingType === 'AUTO').length} AUTO / ${doc.campaigns.length}`)
  L(`   placement modifiers: ${doc.campaigns.filter((x) => x.placementBidding.length).length}/${doc.campaigns.length}   sharedTargets: ${doc.sharedTargets.length}`)

  const { existing, names, market } = await ctxFor(c.market)
  const plan = planApplication(doc, { productToken: `ZZTEST${c.token}`, asins: ['B0TESTASIN'] }, existing, {
    market, existingCampaignNames: names, skipSharedTargets: doc.sharedTargets.map((t) => t.expression),
  })
  L(`   plan: allowed=${plan.allowed}`)
  for (const b of plan.blockers) L(`     BLOCKER  ${b.slice(0, 150)}`)
  for (const w of plan.warnings) L(`     warning  ${w.slice(0, 150)}`)

  const all = plan.campaigns.flatMap((x) => x.adGroups.flatMap((g) => g.targets as T[]))
  const beforeDropped = all.filter((t) => !t.isNegative && !isKw(t)).length
  const autoOk = all.filter((t) => !t.isNegative && t.kind?.toUpperCase() === 'AUTO' && t.autoClause).length
  const prodT = all.filter((t) => !t.isNegative && ['PRODUCT', 'CATEGORY'].includes(t.kind?.toUpperCase() ?? '')).length
  const negProd = all.filter((t) => t.isNegative && t.kind?.toUpperCase() === 'PRODUCT').length
  const stillDropped = all.filter((t) => !t.isNegative && t.kind?.toUpperCase() === 'AUTO' && !t.autoClause).length
  const kws = all.filter((t) => !t.isNegative && isKw(t) && ['EXACT', 'PHRASE', 'BROAD'].includes(mt(t))).length
  const negKw = all.filter((t) => t.isNegative && isKw(t) && ['EXACT', 'PHRASE'].includes(mt(t))).length
  L(`   creates: ${kws} keywords · ${negKw} neg keywords · ${autoOk} auto clauses · ${prodT} product targets · ${negProd} neg products`)
  L(`   dropped: ${beforeDropped} before AX3.0  →  ${stillDropped} now${beforeDropped !== stillDropped ? '   ← recovered ' + (beforeDropped - stillDropped) : ''}`)
}

await prisma.$disconnect()
