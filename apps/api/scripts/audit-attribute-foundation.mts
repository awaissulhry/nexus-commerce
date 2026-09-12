/** Read-only inventory used by the product attribute foundation work. */
import prisma from '../src/db.js'

try {
  const [families, attributes, categories, mappings, products, schemas] = await Promise.all([
    prisma.productFamily.findMany({ select: { id: true, code: true, label: true, parentFamilyId: true, _count: { select: { products: true, familyAttributes: true } } } }),
    prisma.customAttribute.findMany({ include: { group: true, options: true, familyAttributes: true } }),
    prisma.category.findMany({ select: { id: true, slug: true, name: true, parentId: true, attributes: true, _count: { select: { products: true } } } }),
    prisma.categoryChannelMapping.findMany({ select: { categoryId: true, channel: true, marketplace: true, channelCategoryId: true, reviewedAt: true } }),
    prisma.product.findMany({ where: { deletedAt: null }, select: { id: true, sku: true, parentId: true, productType: true, familyId: true, categoryAttributes: true, countryOfOrigin: true, weightValue: true, weightUnit: true } }),
    prisma.categorySchema.findMany({ where: { isActive: true }, select: { channel: true, marketplace: true, productType: true, fetchedAt: true } }),
  ])
  const effectiveFields = Object.fromEntries(families.map(family => {
    const ancestors = new Set<string>()
    let current: typeof family | undefined = family
    while (current && !ancestors.has(current.id)) {
      ancestors.add(current.id)
      current = families.find(f => f.id === current!.parentFamilyId)
    }
    return [family.code, attributes.filter(a => a.familyAttributes.some(link => ancestors.has(link.familyId))).map(a => a.code).sort()]
  }))
  const grouped = new Map<string, { products: number; parents: number; keys: Set<string>; originConflicts: number; families: Set<string> }>()
  for (const p of products) {
    const pt = p.productType ?? '(none)'
    const g = grouped.get(pt) ?? { products: 0, parents: 0, keys: new Set(), originConflicts: 0, families: new Set() }
    g.products++; if (!p.parentId) g.parents++
    const attrs = (p.categoryAttributes ?? {}) as Record<string, unknown>
    Object.keys(attrs).forEach(k => g.keys.add(k))
    if (p.familyId) g.families.add(p.familyId)
    if (p.countryOfOrigin && attrs.country_of_origin && p.countryOfOrigin !== attrs.country_of_origin) g.originConflicts++
    grouped.set(pt, g)
  }
  console.log(JSON.stringify({
    families, attributes, categories, mappings, schemas, effectiveFields,
    roots: products.filter(p => !p.parentId).map(p => ({ id: p.id, sku: p.sku, productType: p.productType, family: families.find(f => f.id === p.familyId)?.code ?? null })),
    productTypes: [...grouped].map(([productType, g]) => ({ productType, ...g, keys: [...g.keys].sort(), families: [...g.families] })),
    fixture: products.filter(p => p.sku === 'GALE-JACKET').map(({ categoryAttributes, ...p }) => p),
  }, null, 2))
} finally { await prisma.$disconnect() }
