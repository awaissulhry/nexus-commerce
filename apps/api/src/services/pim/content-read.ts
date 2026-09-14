import { CONTENT_COLUMNS, PRIMARY_CONTENT_LOCALE } from './content-locale.js'
import { normalizeLanguage } from './content-language.js'
import { resolveContent, resolveContentBatch, translationMissing, type ContentListing, type ContentProduct, type Coordinate, type ResolvedContent } from './content-resolver.js'
import type { ResolvedValue } from './attribute-resolver.js'

type Row = Record<string, any>
export function contentLanguages(product: Row, parent?: Row | null): string[] {
  return [...new Set([PRIMARY_CONTENT_LOCALE, ...[product, parent].flatMap(owner => (owner?.translations ?? []).map((row: Row) => normalizeLanguage(row.language)))])]
}
export function contentKeys(product: Row, parent?: Row | null, declared: readonly string[] = []): string[] {
  return [...new Set([...Object.keys(CONTENT_COLUMNS), ...declared, ...[product, parent].flatMap(owner => (owner?.translations ?? []).flatMap((row: Row) => Object.keys(row.attributes ?? {})))])]
}
export function contentListing(product: Row, listing?: Row | null, coordinate?: Coordinate, languages?: readonly string[]): ContentListing | null {
  if (!listing) return null
  const address = coordinate ?? listing.coordinate ?? (listing.channel && (listing.marketplace || listing.region) ? {
    channel: listing.channel, market: !listing.marketplace || listing.marketplace === 'DEFAULT' ? listing.region : listing.marketplace,
    ...(listing.channelConnectionId ? { accountId: listing.channelConnectionId } : {}), ...(listing.aliasId || listing.aliasKey ? { aliasId: listing.aliasId ?? listing.aliasKey } : {}),
  } : undefined)
  const ordered = languages ?? listing.languages
  if (!address || !ordered?.length) throw new Error('Content listing reads require a coordinate and hydrated Marketplace.languages.')
  return { id: listing.id, productId: listing.productId ?? product.id, workspaceId: listing.workspaceId, coordinate: address, languages: ordered,
    translations: listing.translations, title: listing.title, description: listing.description,
    titleOverride: listing.titleOverride, descriptionOverride: listing.descriptionOverride, bulletPointsOverride: listing.bulletPointsOverride,
    followMasterTitle: listing.followMasterTitle, followMasterDescription: listing.followMasterDescription, followMasterBulletPoints: listing.followMasterBulletPoints }
}
/** Existing wire names retained; the resolver supplies their facts once. */
export function contentAttribute(content: ResolvedContent, productId: string, parentId?: string | null): ResolvedValue {
  const source = content.tier === 'pin' ? content.follows ? 'channelSnapshot' : 'channelExplicit'
    : content.tier === 'language' ? parentId ? 'variantLocale' : 'masterLocale' : content.tier === 'source' ? 'masterColumn' : 'default'
  const translationState = translationMissing(content, content.requested) ? 'fallback'
    : content.translation?.outdated ? 'outdated' : content.translation?.reviewedAt ? 'reviewed'
    : content.translation && content.translation.source !== 'manual' ? 'draft' : 'current'
  return { content, value: content.value, source, inheritedFrom: content.tier === 'pin' ? content.provenance.from : content.ownerId ?? productId,
    requestedLocale: content.requested, effectiveLocale: content.language, language: content.language, requested: content.requested,
    translationState, tier: content.tier, follows: content.follows, drift: content.drift, contentProvenance: content.provenance }
}
export function resolveContentAttributes(input: { product: Row; parent?: Row | null; listing?: Row | null; coordinate?: Coordinate; languages?: readonly string[]; requested: string; localizableKeys?: readonly string[] }): Record<string, ResolvedValue> {
  const listing = contentListing(input.product, input.listing, input.coordinate, input.languages)
  const fields = contentKeys(input.product, input.parent, input.localizableKeys)
  const resolved = resolveContentBatch({ members: [{ product: input.product as ContentProduct, parent: input.parent as ContentProduct,
    listing, localizableKeys: fields }], fields, addresses: [{ requested: input.requested, ...(listing ? { coordinate: listing.coordinate } : input.coordinate ? { coordinate: input.coordinate } : {}) }] })[0].fields
  return Object.fromEntries(Object.entries(resolved).map(([key, value]) => [key, contentAttribute(value, input.product.id, input.product.parentId)]))
}

/** R10: raw resolver absence must not change an established list-shaped sheet/API wire. */
export function contentWireValue(value: unknown, shape?: string, field?: string): unknown {
  // Amazon exposes one search-term string; the shared content store uses String[].
  if (shape === 'scalar' && field === 'keywords' && Array.isArray(value)) return value.join(' ')
  return shape === 'list' && value == null ? [] : value
}

/** Preserve a scalar channel search-term phrase as one item, without splitting its words. */
export function contentStorageValue(field: string, value: unknown): unknown {
  return field === 'keywords' && typeof value === 'string' ? value ? [value] : [] : value
}

/** Store readers require the same hydrated product and market authority as the sheet. */
export function listingContentState(listing: Row, requested: string, field: string, localizableKeys: readonly string[] = []) {
  if (!listing.product) throw new Error('Listing content requires its hydrated product and translations.')
  const owner = listing.product
  const hydrated = contentListing(owner, listing)!
  return resolveContent({ product: owner, parent: owner.parent, listing: hydrated, localizableKeys,
    field, address: { requested: normalizeLanguage(requested), coordinate: hydrated.coordinate } })
}
