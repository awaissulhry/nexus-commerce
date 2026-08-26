// RD-P0 — what the FOUNDATION depends on. Read-only.
//
// The study (2026-08-11) measured the engine. This measures only the things P0 is about to build
// on: the four scope grains, whether every row can be addressed by them, and whether a
// campaign-grain row is derivable from data that exists today.
//
// Deliberately NO .catch(() => []) anywhere: a swallowed error reads exactly like a zero.
import '../src/env.js'
import prisma from '../src/db.js'

async function main() {
  console.log('=== A. Groups × derived scope ===')
  const groups = await prisma.rankScheduleGroup.findMany({ orderBy: { name: 'asc' } })
  const members = await prisma.adSchedule.findMany({
    where: { groupId: { not: null } },
    select: { id: true, groupId: true, campaignId: true, enabled: true, lastEvaluatedAt: true, lastApplied: true },
  })
  const campIds = [...new Set(members.map((m) => m.campaignId))]
  const camps = await prisma.campaign.findMany({
    where: { id: { in: campIds } },
    select: { id: true, name: true, marketplace: true, portfolioId: true, status: true, externalCampaignId: true },
  })
  const campById = new Map(camps.map((c) => [c.id, c]))

  let multiMarket = 0, noMarket = 0, withPortfolio = 0
  for (const g of groups) {
    const ms = members.filter((m) => m.groupId === g.id)
    const mkts = [...new Set(ms.map((m) => campById.get(m.campaignId)?.marketplace).filter(Boolean))].sort()
    if (mkts.length > 1) multiMarket++
    if (mkts.length === 0) noMarket++
    if (g.portfolioId) withPortfolio++
    console.log(
      `${g.enabled ? 'ON ' : 'off'} | ${g.name.padEnd(34)} | storedMkt=${String(g.marketplace).padEnd(5)} | derivedMkts=[${mkts.join(',') || '-'}] | members=${String(ms.length).padStart(2)} | pf=${g.portfolioId ?? '-'} | id=${g.id}`,
    )
  }
  console.log(`\ngroups=${groups.length} · enabled=${groups.filter((g) => g.enabled).length} · multi-market=${multiMarket} · no-market=${noMarket} · portfolio-scoped=${withPortfolio}`)

  console.log('\n=== B. Campaign grain — is an identity row derivable TODAY? ===')
  console.log(`member AdSchedule rows = ${members.length} · distinct campaigns = ${campIds.length}`)
  const resolved = campIds.filter((id) => campById.has(id))
  console.log(`campaigns that resolve to a Campaign row: ${resolved.length}/${campIds.length}`)
  console.log(`  with a marketplace : ${camps.filter((c) => c.marketplace).length}`)
  console.log(`  with a portfolioId : ${camps.filter((c) => c.portfolioId).length}`)
  console.log(`  with an externalId : ${camps.filter((c) => c.externalCampaignId).length}`)

  // product line reach — the fourth grain. AdProductAd → productId → parent (the line).
  const ads = await prisma.adProductAd.findMany({
    where: { productId: { not: null }, adGroup: { campaignId: { in: campIds } } },
    select: { productId: true, adGroup: { select: { campaignId: true } } },
  })
  const lineCampaigns = new Set(ads.map((a) => a.adGroup?.campaignId).filter(Boolean) as string[])
  console.log(`  reachable by a product line: ${lineCampaigns.size}/${campIds.length}`)

  const prodIds = [...new Set(ads.map((a) => a.productId).filter(Boolean) as string[])]
  const prods = prodIds.length
    ? await prisma.product.findMany({ where: { id: { in: prodIds } }, select: { id: true, parentId: true, sku: true } })
    : []
  const lineHeads = new Set(prods.map((p) => p.parentId ?? p.id))
  console.log(`  distinct product lines over this page's campaigns: ${lineHeads.size}`)

  console.log('\n=== C. Per-group campaign identity sample (first enabled group) ===')
  const firstOn = groups.find((g) => g.enabled)
  if (firstOn) {
    for (const m of members.filter((x) => x.groupId === firstOn.id).slice(0, 6)) {
      const c = campById.get(m.campaignId)
      console.log(`  ${c?.name ?? '??'} | mkt=${c?.marketplace} | pf=${c?.portfolioId ?? '-'} | status=${c?.status} | schedEnabled=${m.enabled} | lastApplied=${m.lastApplied ?? '-'}`)
    }
  } else {
    console.log('  (no enabled group)')
  }

  console.log('\n=== D. Scope-options universe (what the pickers can offer) ===')
  const allCamps = await prisma.campaign.count()
  const pfs = await prisma.amazonAdsPortfolio.count()
  console.log(`Campaign rows in account = ${allCamps} · AmazonAdsPortfolio rows = ${pfs}`)
  const mkts = await prisma.campaign.groupBy({ by: ['marketplace'], _count: { _all: true } })
  console.log('markets: ' + mkts.map((m) => `${m.marketplace ?? 'null'}=${m._count._all}`).join(' · '))
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => { console.error(e); return prisma.$disconnect().then(() => process.exit(1)) })
