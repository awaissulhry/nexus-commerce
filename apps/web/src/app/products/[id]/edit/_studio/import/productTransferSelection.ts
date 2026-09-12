import type { ProductTransferOptions, ProductTransferSelection } from '@nexus/shared/catalog-transfer'

export interface ProductTransferContext { productId: string; market: string; channel?: string; accountId?: string; aliasKey?: string | null; locale?: string }
export type DestinationMode = 'current' | 'aliases' | 'all' | 'custom'
export function editorTransferSelection(options: ProductTransferOptions, context: ProductTransferContext, productIds: string[], allDestinations = false): ProductTransferSelection {
  const listings = options.listings.filter(l => productIds.includes(l.productId) && (allDestinations || l.channel === context.channel && l.accountId === context.accountId && l.marketplace === context.market && l.aliasKey === (context.aliasKey ?? '')))
  const includeShared = allDestinations || !context.channel
  const locale = context.locale || options.markets.find(m => m.code === context.market)?.language
  return { productIds, includeShared, listingIds: listings.map(l => l.id), locales: includeShared ? allDestinations ? options.locales : options.locales.filter(l => l === locale) : [] }
}

/** Changing products never silently adds shared data or another language. */
export function updateTransferProducts(options: ProductTransferOptions, context: ProductTransferContext, selection: ProductTransferSelection, productIds: string[], mode: DestinationMode): ProductTransferSelection {
  const ids = new Set(productIds)
  const selectedCoordinates = new Set(options.listings.filter(l => selection.listingIds.includes(l.id)).map(l => JSON.stringify([l.channel, l.accountId, l.marketplace, l.aliasKey])))
  const listings = options.listings.filter(l => ids.has(l.productId) && (mode === 'all' || mode === 'custom'
    ? mode === 'all' || selectedCoordinates.has(JSON.stringify([l.channel, l.accountId, l.marketplace, l.aliasKey]))
    : l.channel === context.channel && l.accountId === context.accountId && l.marketplace === context.market && (mode === 'aliases' || l.aliasKey === (context.aliasKey ?? ''))))
  return { ...selection, productIds: [...ids], listingIds: listings.map(l => l.id) }
}

export function transferDestinationGroups(options: ProductTransferOptions, productIds: string[]) {
  const products = new Set(productIds)
  const groups = new Map<string, { key: string; label: string; listingIds: string[] }>()
  const accounts = new Map(options.accounts.map(a => [a.id, a.displayName ?? a.id]))
  for (const listing of options.listings) {
    if (!products.has(listing.productId)) continue
    const key = JSON.stringify([listing.channel, listing.accountId, listing.marketplace, listing.aliasKey])
    if (!groups.has(key)) groups.set(key, { key, label: `${listing.channel} ${listing.marketplace} · ${accounts.get(listing.accountId) ?? 'Account unavailable'} · ${listing.aliasLabel ?? (listing.aliasKey || 'Primary listing')}`, listingIds: [] })
    groups.get(key)!.listingIds.push(listing.id)
  }
  return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label))
}
