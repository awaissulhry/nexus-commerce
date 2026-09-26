import type { ProductTransferOptions, ProductTransferSelection } from '@nexus/shared/catalog-transfer'

/**
 * PSIE — the Export dialog's choices, as pure functions. The dialog asks three things and defaults all of them:
 * which products (the whole family), where (Shared + the channel on screen), which columns (all). Languages are not
 * a choice: each channel market brings its own, and the Shared tab gets the languages of the chosen markets.
 */
export type ExportProducts = 'product' | 'family' | 'selected'
export type ExportColumns = 'all' | 'visible'
export interface ExportContext {
  productId: string; market: string; channel?: string; accountId?: string; aliasKey?: string | null; locale?: string
  /** Rows selected in the sheet (product ids). */
  selectedIds: string[]
}
export interface ExportChoice { products: ExportProducts; shared: boolean; destinations: string[]; columns: ExportColumns }
export interface ExportDestination {
  key: string; channel: string; marketplace: string; accountId: string
  /** "Amazon IT", plus the account when two accounts sell on the same channel market. */
  label: string
  /** Listings of the chosen products here, counting every listing alias. */
  listings: number
  /** Listings beyond one per product: the listing aliases. */
  aliases: number
  language: string
}

const CHANNEL_NAMES: Record<string, string> = { AMAZON: 'Amazon', EBAY: 'eBay', SHOPIFY: 'Shopify', ETSY: 'Etsy' }
export const channelLabel = (channel: string) => CHANNEL_NAMES[channel] ?? channel.charAt(0) + channel.slice(1).toLowerCase()
export const destinationKey = (l: { channel: string; accountId: string; marketplace: string }) => JSON.stringify([l.channel, l.accountId, l.marketplace])

export function languageName(code: string): string {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code.toUpperCase() } catch { return code.toUpperCase() }
}

export function exportProductIds(options: Pick<ProductTransferOptions, 'products'>, context: ExportContext, products: ExportProducts): string[] {
  const all = options.products.map(p => p.id)
  if (products === 'family') return all
  if (products === 'selected') return all.filter(id => context.selectedIds.includes(id))
  return all.includes(context.productId) ? [context.productId] : all.slice(0, 1)
}

/** Every channel market the chosen products are listed on; each listing alias is counted, never shown as its own choice. */
export function exportDestinations(options: Pick<ProductTransferOptions, 'listings' | 'accounts' | 'markets'>, productIds: string[]): ExportDestination[] {
  const products = new Set(productIds)
  const groups = new Map<string, ExportDestination & { products: Set<string> }>()
  for (const listing of options.listings) {
    if (!products.has(listing.productId) || !listing.accountId) continue
    const key = destinationKey(listing)
    let group = groups.get(key)
    if (!group) {
      const language = options.markets.find(m => m.channel === listing.channel && m.code === listing.marketplace)?.language ?? ''
      group = { key, channel: listing.channel, marketplace: listing.marketplace, accountId: listing.accountId, label: `${channelLabel(listing.channel)} ${listing.marketplace}`, listings: 0, aliases: 0, language, products: new Set() }
      groups.set(key, group)
    }
    group.listings++
    group.products.add(listing.productId)
  }
  const list = [...groups.values()]
  for (const group of list) {
    group.aliases = group.listings - group.products.size
    // Two accounts on one channel market: name the account so the two choices differ.
    if (list.some(other => other !== group && other.channel === group.channel && other.marketplace === group.marketplace)) {
      const account = options.accounts.find(a => a.id === group.accountId)
      group.label = `${group.label} · ${account?.displayName ?? group.accountId.slice(-6)}`
    }
  }
  return list.map(({ products: _products, ...destination }) => destination).sort((a, b) => a.label.localeCompare(b.label))
}

/** The defaults: the whole family, Shared, and the channel market on screen (with all its listing aliases). */
export function defaultExportChoice(options: Pick<ProductTransferOptions, 'products' | 'listings' | 'accounts' | 'markets'>, context: ExportContext): ExportChoice {
  const destinations = exportDestinations(options, exportProductIds(options, context, 'family'))
  const current = context.channel ? destinations.find(d => d.channel === context.channel && d.marketplace === context.market && (!context.accountId || d.accountId === context.accountId)) : undefined
  return { products: 'family', shared: true, destinations: current ? [current.key] : [], columns: 'all' }
}

/**
 * The Shared tab's languages: the chosen markets' languages and the language on screen, as the options know them. The
 * sheet's market only stands in when no language is on screen (on the Shared scope it picks the attribute dictionary,
 * not a language).
 */
export function exportLanguages(options: Pick<ProductTransferOptions, 'locales' | 'markets'>, context: ExportContext, destinations: ExportDestination[]): string[] {
  const onScreen = context.locale || options.markets.find(m => m.code === context.market)?.language || ''
  const wanted = new Set([...destinations.map(d => d.language), onScreen].filter(Boolean))
  return options.locales.filter(locale => wanted.has(locale))
}

export function exportSelection(options: ProductTransferOptions, context: ExportContext, choice: ExportChoice): ProductTransferSelection {
  const productIds = exportProductIds(options, context, choice.products)
  const chosen = exportDestinations(options, productIds).filter(d => choice.destinations.includes(d.key))
  const keys = new Set(chosen.map(d => d.key))
  return {
    productIds,
    includeShared: choice.shared,
    listingIds: options.listings.filter(l => productIds.includes(l.productId) && keys.has(destinationKey(l))).map(l => l.id),
    locales: choice.shared ? exportLanguages(options, context, chosen) : [],
  }
}

/** Why Download is off, in one sentence; `null` when the choice can be exported. */
export function exportBlocker(selection: ProductTransferSelection): string | null {
  if (!selection.productIds.length) return 'Select rows in the sheet first, or choose another product option.'
  if (!selection.includeShared && !selection.listingIds.length) return 'Choose Shared details or at least one channel.'
  return null
}
