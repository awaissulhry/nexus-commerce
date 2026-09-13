import prisma from '../../db.js'
import { loadVariationProjectionInput } from './variation-theme-facts.js'
import { resolveVariationProjection, type ResolveVariationInput } from './variation-rules.service.js'
import { readExcludedListingIds } from './variation-excluded.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'

export function storedVariationValues(product: { categoryAttributes: unknown; variantAttributes: unknown }, axes: string[]): Record<string, string> {
  const bag = (value: unknown): Record<string, string> => value && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === 'string' || typeof v === 'number').map(([k, v]) => [k, String(v)])) : {}
  const category = product.categoryAttributes as { variations?: unknown } | null
  const primary = bag(category?.variations), legacy = bag(product.variantAttributes)
  return Object.fromEntries(axes.map(axis => {
    const value = Object.entries(primary).find(([key]) => canonicalVariantAxis(key) === canonicalVariantAxis(axis))?.[1]
      ?? Object.entries(legacy).find(([key]) => canonicalVariantAxis(key) === canonicalVariantAxis(axis))?.[1] ?? ''
    return [axis, value]
  }))
}

/** Exact listing context for non-sheet consumers. Ambiguous accounts are an error, never first-row wins. */
export async function loadStoredVariationProjection(address: { productId: string; channel: string; market: string; listingId?: string; accountId?: string | null; aliasKey?: string }, rule?: ResolveVariationInput['rule']) {
  const family = await prisma.product.findUniqueOrThrow({ where: { id: address.productId }, select: { id: true, version: true, variationAxes: true, variationTheme: true, productType: true,
    children: { where: { deletedAt: null }, select: { id: true, sku: true, categoryAttributes: true, variantAttributes: true } } } })
  const parents = await prisma.channelListing.findMany({ where: { productId: family.id, channel: address.channel, marketplace: address.market, aliasKey: address.aliasKey ?? '',
    ...(address.listingId ? { id: address.listingId } : address.accountId !== undefined ? { channelConnectionId: address.accountId } : {}) },
    select: { id: true, version: true, variationTheme: true, variationMapping: true, platformAttributes: true, externalListingId: true, listingStatus: true, channelConnectionId: true, aliasKey: true } })
  if (parents.length > 1) throw new Error('Choose the account for this variation projection; more than one listing matches.')
  const listing = parents[0] ?? null
  const children = listing ? await prisma.channelListing.findMany({ where: { productId: { in: family.children.map(c => c.id) }, channel: address.channel, marketplace: address.market, channelConnectionId: listing.channelConnectionId, aliasKey: listing.aliasKey }, select: { id: true, productId: true } }) : []
  const excluded = await readExcludedListingIds(children.map(c => c.id))
  const alias = address.aliasKey ?? ''
  const input = await loadVariationProjectionInput({ coordinate: { channel: address.channel, marketplace: address.market, label: `${address.channel} · ${address.market}` }, market: address.market, accountId: listing?.channelConnectionId ?? address.accountId ?? null, columns: [],
    family: { rootId: family.id, familyAxes: family.variationAxes, productVersion: family.version, productTheme: family.variationTheme, productType: family.productType, childIds: family.children.map(c => c.id),
      variants: family.children.map(c => { const own = children.find(l => l.productId === c.id); return { id: c.id, sku: c.sku, included: !!own && !excluded.has(own.id), axisValues: storedVariationValues(c, family.variationAxes) } }) },
    parentListings: new Map([[alias, listing ? { ...listing, platformAttributes: listing.platformAttributes as Record<string, unknown> | null } : null]]), ...(rule !== undefined ? { rule } : {}),
  }, alias)
  return { input, cell: resolveVariationProjection(input) }
}
