// READ-ONLY. What a "replicate a portfolio" flow would actually find in prod.
// No writes, no Amazon calls.
const prisma = (await import('../src/db.js')).default
const L = (s = '') => console.log(s)

const camps = await prisma.campaign.findMany({
  where: { status: { not: 'ARCHIVED' } },
  select: { id: true, name: true, marketplace: true, portfolioId: true, adProduct: true, targetingType: true, dailyBudget: true },
})
L(`active campaigns: ${camps.length}`)

const byMk = new Map<string, number>()
for (const c of camps) byMk.set(c.marketplace ?? '?', (byMk.get(c.marketplace ?? '?') ?? 0) + 1)
L(`by marketplace: ${[...byMk].map(([k, v]) => `${k}=${v}`).join(' ')}`)

const withPf = camps.filter((c) => c.portfolioId)
L(`\nwith portfolioId: ${withPf.length} / ${camps.length}  (${((withPf.length / Math.max(1, camps.length)) * 100).toFixed(0)}%)`)

const pfs = await prisma.amazonAdsPortfolio.findMany({ select: { externalPortfolioId: true, name: true, state: true, lastSyncedAt: true } })
L(`AmazonAdsPortfolio rows: ${pfs.length}`)
const pfName = new Map(pfs.map((p) => [p.externalPortfolioId, p.name]))

const grp = new Map<string, { mk: Set<string>; names: string[] }>()
for (const c of withPf) {
  const g = grp.get(c.portfolioId!) ?? { mk: new Set<string>(), names: [] }
  g.mk.add(c.marketplace ?? '?'); g.names.push(c.name)
  grp.set(c.portfolioId!, g)
}
L('\n── portfolios with live campaigns ──────────────────────────────────')
for (const [pid, g] of [...grp].sort((a, b) => b[1].names.length - a[1].names.length)) {
  L(`  ${(pfName.get(pid) ?? '(not synced locally)').padEnd(34)} ${String(g.names.length).padStart(3)} campaigns  [${[...g.mk].join(',')}]  id=${pid}`)
  L(`      e.g. ${g.names.slice(0, 3).join(' | ')}`)
}

// How many follow the IT-TOKEN-SP-Role convention the blueprint role-deriver needs?
const conv = camps.filter((c) => /^[A-Z]{2}-[A-Z0-9]+-(SP|SB|SD)-/i.test(c.name))
L(`\nname convention IT-TOKEN-SP-Role: ${conv.length} / ${camps.length}`)

// Ad-group / target / product-ad depth for the biggest portfolio.
const top = [...grp].sort((a, b) => b[1].names.length - a[1].names.length)[0]
if (top) {
  const ids = withPf.filter((c) => c.portfolioId === top[0]).map((c) => c.id)
  const ags = await prisma.adGroup.count({ where: { campaignId: { in: ids } } })
  const tg = await prisma.adTarget.count({ where: { adGroup: { campaignId: { in: ids } }, isNegative: false, orphanedAt: null } })
  const ng = await prisma.adTarget.count({ where: { adGroup: { campaignId: { in: ids } }, isNegative: true, orphanedAt: null } })
  const pa = await prisma.adProductAd.count({ where: { adGroup: { campaignId: { in: ids } } } })
  L(`\ntop portfolio "${pfName.get(top[0]) ?? top[0]}": ${ids.length} campaigns · ${ags} ad groups · ${tg} positives · ${ng} negatives · ${pa} product ads`)
}

await prisma.$disconnect()
