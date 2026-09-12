import prisma from '../../../db.js'
import { primaryConnectionIds } from '../../connection-resolver.service.js'
import { categoryForListing, resolveCategoriesForProducts } from './category-mapping.service.js'

/** Marketplace totals and preview products used by the mapping editor. */
export async function listMappingTemplates() {
  const marketplaces = await prisma.marketplace.findMany({
    where: { isActive: true },
    orderBy: [{ channel: 'asc' }, { code: 'asc' }],
  })
  // Per (channel, marketplace) — NOT per channel. Grouping by channel alone counted every
  // marketplace's rows together (495 for Amazon) and then the editor showed 62, which is the
  // kind of number mismatch that makes an operator distrust the whole screen.
  const schemaCounts = await prisma.channelSchema.groupBy({
    by: ['channel', 'marketplace'],
    _count: { fieldKey: true },
  })
  const storedFieldCount = (channel: string, code: string) =>
    schemaCounts
      .filter((c) => c.channel === channel && (c.marketplace === code || c.marketplace === null))
      .reduce((n, c) => n + c._count.fieldKey, 0)

  const rows = marketplaces.map((m) => {
    const mapping = (m.schemaMapping ?? {}) as any
    const overlayTypes = Object.keys(mapping?.byProductType ?? {})
    const expressionCount = Object.keys(mapping?.expressions ?? {}).length
    // Count the DEFAULT bucket and every category overlay. Counting `fields` alone reported
    // "0 mapped" for Amazon·IT, which actually carries 13 rules — all of them in the OUTERWEAR
    // overlay. A picker that says 0 where there are 13 sends the operator to the wrong market.
    const ruleKeys = new Set<string>(Object.keys(mapping?.fields ?? {}))
    for (const t of overlayTypes) {
      for (const k of Object.keys(mapping.byProductType[t] ?? {})) ruleKeys.add(k)
    }
    const ruleCount = ruleKeys.size
    const defaultRuleCount = Object.keys(mapping?.fields ?? {}).length
    return {
      channel: m.channel,
      code: m.code,
      name: m.name,
      currency: m.currency,
      language: m.language,
      region: m.region,
      isParticipating: m.isParticipating,
      fieldCount: storedFieldCount(m.channel, m.code),
      mappedCount: ruleCount,
      defaultRuleCount,
      overlayTypes,
      expressionCount,
      lastSyncedAt: mapping?.lastSyncedAt ?? null,
    }
  })
  return rows
}

export async function listMappingPreviewProducts(input: { channel: string; marketplace: string; q?: string; limit?: string; productId?: string }) {
  const q = (input.q ?? '').trim()
  const limit = Math.min(Number(input.limit) || 25, 100)
  const where: any = { deletedAt: null }
  if (input.productId) where.id = input.productId
  if (q) {
    where.OR = [
      { sku: { contains: q, mode: 'insensitive' } },
      { name: { contains: q, mode: 'insensitive' } },
    ]
  }
  const products = await prisma.product.findMany({
    where,
    select: { id: true, sku: true, name: true, productType: true },
    orderBy: { sku: 'asc' },
    take: limit,
  })
  // Which of them are actually listed on this coordinate — the editor sorts those first,
  // because previewing a product that is not on the channel is the less useful answer.
  const channel = input.channel.toUpperCase()
  const connectionId = (await primaryConnectionIds([channel])).get(channel) ?? null
  const categories = await resolveCategoriesForProducts({ productIds: products.map(p => p.id), channel, marketplace: input.marketplace })
  const listed = await prisma.channelListing.findMany({
    where: {
      productId: { in: products.map((p) => p.id) },
      channel, channelConnectionId: connectionId, aliasKey: '',
      marketplace: input.marketplace,
    },
    select: { productId: true, platformAttributes: true },
  })
  const listedSet = new Set(listed.map((l) => l.productId))
  const rows = products
    .map((p) => ({
      productId: p.id,
      sku: p.sku,
      name: p.name,
      productType: p.productType,
      channelCategoryId: categoryForListing(categories[p.id], channel, listed.find(l => l.productId === p.id)?.platformAttributes).channelCategoryId,
      listedHere: listedSet.has(p.id),
      label: `${p.sku}: ${p.name ?? '—'}`,
    }))
    .sort((a, b) => Number(b.listedHere) - Number(a.listedHere) || a.sku.localeCompare(b.sku))
  return rows
}
