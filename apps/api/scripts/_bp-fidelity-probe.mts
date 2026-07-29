// READ-ONLY. Does the blueprint extractor mis-handle non-KEYWORD targets?
const prisma = (await import('../src/db.js')).default
const L = (s = '') => console.log(s)

const kinds = await prisma.adTarget.groupBy({
  by: ['kind', 'isNegative'],
  _count: { _all: true },
  where: { orphanedAt: null, adGroup: { campaign: { status: { not: 'ARCHIVED' } } } },
})
L('AdTarget by kind (active campaigns, non-orphaned):')
for (const k of kinds.sort((a, b) => b._count._all - a._count._all)) {
  L(`  kind=${String(k.kind).padEnd(10)} negative=${String(k.isNegative).padEnd(5)} ${k._count._all}`)
}

// Sample the non-KEYWORD positives — these are what classifyTarget() sends to sharedTargets.
const nonKw = await prisma.adTarget.findMany({
  where: { kind: { not: 'KEYWORD' }, isNegative: false, orphanedAt: null, adGroup: { campaign: { status: { not: 'ARCHIVED' } } } },
  select: { kind: true, expressionType: true, expressionValue: true, adGroup: { select: { campaign: { select: { name: true, targetingType: true } } } } },
  take: 400,
})
const byVal = new Map<string, number>()
for (const t of nonKw) byVal.set(`${t.kind}:${t.expressionValue}`, (byVal.get(`${t.kind}:${t.expressionValue}`) ?? 0) + 1)
L(`\nnon-KEYWORD positive targets: ${nonKw.length} (sample of distinct values, with how many campaigns share each)`)
for (const [v, n] of [...byVal].sort((a, b) => b[1] - a[1]).slice(0, 15)) L(`  ${v.padEnd(40)} ×${n}`)

// Campaign.targetingType — is it populated? The blueprint never reads it.
const tt = await prisma.campaign.groupBy({ by: ['targetingType'], _count: { _all: true }, where: { status: { not: 'ARCHIVED' } } })
L(`\nCampaign.targetingType: ${tt.map((t) => `${t.targetingType ?? 'NULL'}=${t._count._all}`).join('  ')}`)

// Would replication collide on names? Campaigns whose name has no product token are copied verbatim.
const air = await prisma.campaign.findMany({ where: { portfolioId: '190601227863497' }, select: { name: true, targetingType: true, dynamicBidding: true } })
L('\nIT AIREON campaigns (the one convention-clean portfolio):')
for (const c of air) L(`  ${c.name.padEnd(34)} targetingType=${c.targetingType ?? 'NULL'} placement=${JSON.stringify((c.dynamicBidding as { placementBidding?: unknown })?.placementBidding ?? null)}`)

await prisma.$disconnect()
