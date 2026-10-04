import prisma from '../../db.js'
import { loadVariationProjectionInput } from './variation-theme-facts.js'
import { resolveVariationProjection, type ResolveVariationInput } from './variation-rules.service.js'
import { readExcludedListingIds } from './variation-excluded.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'
import { parseOwnAxisKey } from '@nexus/shared/variation-mapping'
import { ownAxisValuesFor, storedOwnAxisKeys } from './variation-own-axes.js'
import { marketLanguages } from './market-languages.js'
import { variationDictionary } from './variation-dictionary.js'
import { ebayMarketWords } from './ebay-market-label.js'

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

/**
 * VTR step 0 — the CHANNEL value of each included axis, taken from the resolved cells a publisher already holds (pins,
 * value maps): the value the Information sheet shows (`axisValuesFromCells`). A cell the resolver did not map keeps the
 * stored value; a mapped blank is a missing value, never a silent fallback to Shared.
 *
 * E1b (2026-10-05) — `marketWord` (eBay only, `ebayMarketWords`): a stored value that goes out as it is (no mapped cell,
 * or a channel-only axis from a Shared attribute) is sent as the dictionary option's word in the market's language
 * (`black` → `Nero`), the same word the resolver gives a mapped eBay cell. A mapped cell (a pin, a value map) is sent as
 * the cell shows it.
 */
export function channelAxisValues(
  stored: Record<string, string>,
  axes: Array<{ axisKey: string; familyKey: string; included: boolean }>,
  cells: Record<string, { value?: unknown; status?: string } | undefined>,
  fields: Array<{ fieldKey: string; sheetKey?: string | null }>,
  marketWord?: ((attribute: string, value: string) => string) | null,
): Record<string, string> {
  const values = { ...stored }
  const asStored = (key: string, attribute: string) => {
    if (marketWord && typeof values[key] === 'string' && values[key].trim()) values[key] = marketWord(attribute, values[key])
  }
  for (const axis of axes.filter(a => a.included)) {
    // Sheet pop-up P3 — a channel-only axis: `own:shared:` keeps the Shared attribute value it was loaded with; an
    // `own:channel:<column>` value is that column's cell here (never the Shared value), matched on the sheet key.
    const own = parseOwnAxisKey(axis.familyKey)
    if (own?.from === 'shared') { asStored(axis.familyKey, own.field); continue }
    const field = own
      ? fields.find(f => (f.sheetKey ?? f.fieldKey) === own.field) ?? fields.find(f => canonicalVariantAxis(f.sheetKey ?? f.fieldKey) === canonicalVariantAxis(own.field))
      : fields.find(f => canonicalVariantAxis(f.sheetKey ?? f.fieldKey) === axis.axisKey)
    const cell = field ? cells[field.fieldKey] : undefined
    if (cell?.status !== 'mapped') { if (!own) asStored(axis.familyKey, axis.familyKey); continue }
    const value = cell.value
    values[axis.familyKey] = (typeof value === 'string' && value.trim()) || typeof value === 'number' || typeof value === 'boolean' ? String(value) : ''
  }
  return values
}

/** E1b (2026-10-05) — the eBay market word of one market (`channelAxisValues`' `marketWord`): one dictionary read. */
export async function loadEbayMarketWords(market: string): Promise<(attribute: string, value: string) => string> {
  const [dictionary, languages] = await Promise.all([variationDictionary(), marketLanguages('EBAY', market)])
  return ebayMarketWords(dictionary, languages[0])
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
      // P3: plus the listing's channel-only axes — a Shared attribute's value here; a channel column's value is filled
      // by `channelAxisValues` from the publisher's resolved cells (empty until then, never the Shared value).
      variants: family.children.map(c => { const own = children.find(l => l.productId === c.id); return { id: c.id, sku: c.sku, included: !!own && !excluded.has(own.id), axisValues: { ...storedVariationValues(c, family.variationAxes), ...ownAxisValuesFor(storedOwnAxisKeys(address.channel, listing), null, c.categoryAttributes) } } }) },
    parentListings: new Map([[alias, listing ? { ...listing, platformAttributes: listing.platformAttributes as Record<string, unknown> | null } : null]]), ...(rule !== undefined ? { rule } : {}),
  }, alias)
  return { input, cell: resolveVariationProjection(input) }
}
