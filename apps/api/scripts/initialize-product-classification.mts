/** Plan first. --apply classifies unassigned roots only, with version checks and an audit event. */
import prisma from '../src/db.js'

const reviewedFamilyBySku: Record<string, string> = { 'AIRMESH-JACKET': 'jackets', 'WATERPROOF-OVERJACKET-BLACK-MEN': 'rainwear' }
const familyForType: Record<string, string> = { OUTERWEAR: 'jackets', COAT: 'coats', GLOVES: 'gloves', SUIT: 'suits', PANTS: 'trousers', AUTO_ACCESSORY: 'accessories' }

try {
  const [products, families, categories, listings] = await Promise.all([
    prisma.product.findMany({ where: { deletedAt: null }, select: { id: true, sku: true, name: true, version: true, parentId: true, familyId: true, productType: true, _count: { select: { categories: true } } } }),
    prisma.productFamily.findMany({ select: { id: true, code: true } }),
    prisma.category.findMany({ where: { code: { startsWith: 'foundation_' } }, select: { id: true, code: true } }),
    prisma.channelListing.findMany({ where: { aliasKey: '', channel: { in: ['AMAZON', 'EBAY'] } }, select: { productId: true, channel: true, marketplace: true, platformAttributes: true } }),
  ])
  const proposals = products.filter(p => !p.parentId && !p.familyId && p._count.categories === 0 && familyForType[p.productType ?? '']).map(p => {
    const familyCode = reviewedFamilyBySku[p.sku] ?? familyForType[p.productType!]
    return { id: p.id, sku: p.sku, name: p.name, version: p.version, productType: p.productType, familyCode,
      familyId: families.find(f => f.code === familyCode)?.id,
      categoryId: categories.find(c => c.code === `foundation_${familyCode}`)?.id }
  })
  if (proposals.some(p => !p.familyId || !p.categoryId)) throw new Error('Run seed-attribute-foundation.mts --apply first')
  const roots = new Map(products.map(p => [p.id, p.parentId ?? p.id]))
  const candidates = new Map<string, { categoryId: string; channel: string; marketplace: string; ids: Set<string> }>()
  for (const listing of listings) {
    const proposal = proposals.find(p => p.id === roots.get(listing.productId))
    if (!proposal) continue
    const attrs = listing.platformAttributes as Record<string, unknown> | null
    const raw = listing.channel === 'AMAZON' ? attrs?.productType ?? proposal.productType : attrs?.categoryId
    if (raw === undefined || raw === null || String(raw).trim() === '') continue
    const key = `${proposal.categoryId}:${listing.channel}:${listing.marketplace}`
    const candidate = candidates.get(key) ?? { categoryId: proposal.categoryId!, channel: listing.channel, marketplace: listing.marketplace, ids: new Set<string>() }
    candidate.ids.add(String(raw).trim()); candidates.set(key, candidate)
  }
  const mappings = [...candidates.values()].map(c => ({ ...c, ids: [...c.ids].sort(), needsReview: true }))
  console.log(JSON.stringify({ action: 'plan', proposals, mappings, skippedRoots: products.filter(p => !p.parentId && !proposals.some(v => v.id === p.id)).map(p => ({ sku: p.sku, name: p.name, productType: p.productType, reason: p.familyId || p._count.categories ? 'Already classified' : 'No reliable type mapping' })), attributeValuesChanged: 0 }, null, 2))
  if (process.argv.includes('--apply')) {
    const { productEventService } = await import('../src/services/product-event.service.js')
    const applied: string[] = []
    for (const p of proposals) {
      const changed = await prisma.$transaction(async tx => {
        if (await tx.productCategory.count({ where: { productId: p.id } })) return false
        const result = await tx.product.updateMany({ where: { id: p.id, version: p.version, familyId: null, deletedAt: null }, data: { familyId: p.familyId, version: { increment: 1 } } })
        if (!result.count) return false
        await tx.productCategory.create({ data: { productId: p.id, categoryId: p.categoryId!, isPrimary: true } })
        await productEventService.emitTx(tx, { aggregateId: p.id, aggregateType: 'Product', eventType: 'PRODUCT_UPDATED', data: { familyId: p.familyId, primaryCategoryId: p.categoryId }, metadata: { source: 'SYSTEM', reason: 'Initialize product attribute families from existing product types' } })
        return true
      })
      if (changed) applied.push(p.sku)
    }
    for (const mapping of mappings) {
      if (mapping.ids.length !== 1) continue
      await prisma.categoryChannelMapping.upsert({
        where: { categoryId_channel_marketplace: { categoryId: mapping.categoryId, channel: mapping.channel, marketplace: mapping.marketplace } },
        create: { categoryId: mapping.categoryId, channel: mapping.channel, marketplace: mapping.marketplace, channelCategoryId: mapping.ids[0], notes: 'Imported from consistent existing listing assignments. Review before using for new listings.' },
        update: {},
      })
    }
    console.log(JSON.stringify({ action: 'applied', roots: applied, attributeValuesChanged: 0, mappingConflicts: mappings.filter(m => m.ids.length !== 1) }, null, 2))
  }
} catch (error) { console.error(error); process.exitCode = 1 }
finally { await prisma.$disconnect(); if (process.argv.includes('--apply')) process.exit(process.exitCode ?? 0) }
