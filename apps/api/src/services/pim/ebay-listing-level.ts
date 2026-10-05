/**
 * P1 of fix/product-sheet-editing (report 5 I-1, I-3) — eBay takes ONE value per listing for every item specific that is
 * not a variation axis ("Paese di origine", "Marca", "Stagione", "Colore specifico", "Genere"…). The publisher builds it
 * parent first, then the first variation in SKU order that holds one (`buildSharedListingInput`). These helpers are that
 * rule, so the sheet shows on every row the value eBay receives and a write on any row lands where eBay reads it.
 *
 * The axes are the family's variation projection for the listing — the included axes the publisher itself sends as
 * variation specifics (`buildEbayListingInput`). Per-row values of an aspect that is NOT an axis yet stay stored per row
 * (the Variation theme editor reads them as candidates); only what is shown and written is the listing's one value.
 */
import { aspectCanonicalName } from '../ebay-theme-axes.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'
import { isBlankValue } from './sheet-values.js'
import { familyPublicationOrder } from './family-publication-order.js'

type Store = { kind: string; path?: string[]; column?: string } | null | undefined

/** Axis identities from the names an axis goes by (its eBay name, its family key, its label). */
export function ebayAxisIdentities(names: Array<string | null | undefined>): Set<string> {
  const identities = new Set<string>()
  for (const name of names) if (name && name.trim()) { identities.add(`aspect:${aspectCanonicalName(name)}`); identities.add(`axis:${canonicalVariantAxis(name)}`) }
  return identities
}

/** The axis names of a variation projection's INCLUDED axes: what the publisher sends as variation specifics. */
export function projectionAxisNames(axes: ReadonlyArray<{ included: boolean; channelName?: string | null; familyKey?: string; label?: string }> | null | undefined): string[] {
  return (axes ?? []).filter(axis => axis.included).flatMap(axis => [axis.channelName, axis.familyKey, axis.label]).filter((name): name is string => !!name)
}

/**
 * The family's eBay axes for one listing coordinate, read the way the publisher reads them
 * (`loadStoredVariationProjection`). When the projection cannot be read, the family's own axes stand in.
 */
export async function loadEbayListingAxes(input: { parentId: string; market: string; accountId: string | null; aliasKey?: string; familyAxes?: unknown }): Promise<Set<string>> {
  const fallback = Array.isArray(input.familyAxes) ? input.familyAxes.filter((axis): axis is string => typeof axis === 'string') : []
  try {
    const { loadStoredVariationProjection } = await import('./stored-variation-projection.js')
    const { cell } = await loadStoredVariationProjection({ productId: input.parentId, channel: 'EBAY', market: input.market, accountId: input.accountId, aliasKey: input.aliasKey ?? '' })
    const names = projectionAxisNames(cell.axes)
    return ebayAxisIdentities(names.length ? names : fallback)
  } catch {
    return ebayAxisIdentities(fallback)
  }
}

/** Whether a field (by any of its names: the eBay aspect name, the sheet key, the label) is one of the axes. */
export function isEbayAxis(names: Array<string | null | undefined>, axes: Set<string>): boolean {
  return names.some(name => !!name && (axes.has(`aspect:${aspectCanonicalName(name)}`) || axes.has(`axis:${canonicalVariantAxis(name)}`)))
}

/** An item specific (`platformAttributes.itemSpecifics.<name>`) that is not an axis: eBay takes one value per listing. */
export function isEbayListingLevel(field: { store?: Store; names?: Array<string | null | undefined> }, axes: Set<string>): boolean {
  const store = field.store
  if (store?.kind !== 'platformAttributes' || store.path?.[0] !== 'itemSpecifics' || !store.path[1]) return false
  return !isEbayAxis([store.path[1], ...(field.names ?? [])], axes)
}

/**
 * Follow-up 2026-10-01 (live check, GALE-JACKET) — the eBay Trading fields a variation listing takes ONCE, from its MAIN
 * row (`buildSharedListingInput` reads them from the parent row; `ebayPublicationXml` from the parent's settings): a
 * variation row's own value is never sent, so it is never judged. "Condition is required" was named on all 20 variations.
 * What IS per variation stays per variation: price, quantity, SKU, EAN, axis values, photos (`imageUrls`).
 */
export const EBAY_ITEM_LEVEL_FIELDS: ReadonlySet<string> = new Set([
  'conditionId', 'categoryId', 'subtitle', 'descriptionThemeId', 'listingFormat', 'listingDuration',
  'bestOffer', 'bestOfferFloor', 'bestOfferCeiling', 'handlingTime', 'vatRate', 'videoId', 'quantityLimitPerBuyer',
  'itemLocationCountry', 'itemLocation', 'itemPostalCode', 'merchantLocationKey',
  'packageType', 'packageWeight', 'weightUnit', 'packageLength', 'packageWidth', 'packageHeight', 'dimensionUnit',
  'paymentPolicyId', 'returnPolicyId', 'fulfillmentPolicyId', 'sharedSkuListing', 'compatibility', 'regulatory',
])
const ITEM_LEVEL_COLUMNS: ReadonlySet<string> = new Set(['title', 'description', 'variationTheme'])

/** A field stored where an eBay variation listing takes it from the main row only (not an item specific: see above). */
export function isEbayItemLevel(store: Store): boolean {
  if (store?.kind === 'platformAttributes') return store.path?.length === 1 && EBAY_ITEM_LEVEL_FIELDS.has(store.path[0])
  if (store?.kind === 'listingColumn') return !!store.column && ITEM_LEVEL_COLUMNS.has(store.column)
  return false
}

export interface FamilyRow { productId: string; sku: string; isParent: boolean; value: unknown }

/**
 * The row whose value eBay receives: the parent's when it holds one, else the first variation in SKU order that does —
 * the order `buildSharedListingInput` reads (`[parentRow, ...variantRows]`, first value wins). Null when none holds one.
 */
export function ebayFamilySupplier<T extends FamilyRow>(rows: T[]): T | null {
  const ordered = [...rows].sort(familyPublicationOrder<T>(row => row.isParent))
  return ordered.find(row => !isBlankValue(row.value)) ?? null
}

/** Two stored values say the same thing for eBay (a legacy `"x"` and `["x"]` are one value). */
export function sameEbayValue(a: unknown, b: unknown): boolean {
  const norm = (value: unknown) => JSON.stringify((Array.isArray(value) ? value : [value]).filter(member => !isBlankValue(member)).map(member => String(member).trim()))
  return norm(a) === norm(b)
}

export interface ListingLevelField { key: string; label: string; store?: Store; names?: Array<string | null | undefined> }
export interface ListingLevelValue<T extends FamilyRow> { field: ListingLevelField; supplier: T; value: unknown; differing: T[] }

/**
 * For each listing-level field of one family: the row eBay's value comes from, that value, and the rows whose own value
 * differs (sorted by SKU). `rows` are the rows the listing SENDS (the parent and its included variations); `valueOf`
 * reads a row's own value of a field.
 */
export function ebayListingLevelValues<T extends Omit<FamilyRow, 'value'>>(input: { rows: T[]; fields: ListingLevelField[]; axes: Set<string>; valueOf: (row: T, field: ListingLevelField) => unknown }): Array<ListingLevelValue<T & { value: unknown }>> {
  const out: Array<ListingLevelValue<T & { value: unknown }>> = []
  for (const field of input.fields) {
    if (!isEbayListingLevel(field, input.axes)) continue
    const rows = input.rows.map(row => ({ ...row, value: input.valueOf(row, field) }))
    const supplier = ebayFamilySupplier(rows)
    if (!supplier) continue
    const differing = rows.filter(row => row !== supplier && !isBlankValue(row.value) && !sameEbayValue(row.value, supplier.value)).sort(familyPublicationOrder<T & { value: unknown }>(row => row.isParent))
    out.push({ field, supplier, value: supplier.value, differing })
  }
  return out
}

interface SheetCellLike {
  value: unknown
  layer?: string
  inherited?: boolean
  inheritedFrom?: string | null
  pinned?: boolean
  resettable?: boolean
  mapped?: { value?: unknown; warnings: string[]; errors: string[]; listingLevel?: ListingLevelMark } | null
}
interface SheetRowLike { id: string; sku: string; parentId: string | null; aliasId?: string | null; values: Record<string, SheetCellLike> }
interface SheetColumnLike { key: string; label: string; channelLabel?: string; channels?: Record<string, { store?: unknown } | undefined> }

/**
 * On a cell: where the listing's one value comes from (`productId`/`sku`). `variation`: the cell is on a variation row,
 * so the value is the LISTING's, not the row's (P1 review 4). `ownValue`: this row stores another value eBay does not get.
 */
export interface ListingLevelMark { productId: string; sku: string; variation?: true; ownValue?: unknown }

/**
 * The sheet's eBay scope shows, on every row of a listing, the listing-level value eBay receives (report 5 I-1): the
 * supplying row's cell, marked `mapped.listingLevel`, and a row whose own stored value differs says so. On a VARIATION
 * row the value is the listing's (P1 review 4): shown inherited from the listing's row (`layer: 'alias'`), with no reset
 * of its own — a clear or a set there writes the listing's value. Runs after the Variation theme cells are built, which
 * read the rows' own values for axis candidates. `groups`: each listing (primary and aliases) with its projection's axes
 * and the variations it sends.
 */
export function showEbayListingLevel(input: { rows: SheetRowLike[]; columns: SheetColumnLike[]; label: string
  groups: Array<{ aliasKey: string; axes: ReadonlyArray<{ included: boolean; channelName?: string | null; familyKey?: string; label?: string }> | null | undefined; includedIds: Set<string>; familyAxes?: unknown }> }) {
  const fields: ListingLevelField[] = input.columns.flatMap(col => {
    const store = col.channels?.[input.label]?.store as Store
    return store ? [{ key: col.key, label: col.label, store, names: [col.key, col.label, col.channelLabel] }] : []
  })
  for (const group of input.groups) {
    const rows = input.rows.filter(row => (row.aliasId ?? '') === group.aliasKey)
    const parent = rows.find(row => row.parentId === null)
    if (!parent || rows.length < 2) continue
    const names = projectionAxisNames(group.axes)
    const axes = ebayAxisIdentities(names.length ? names : Array.isArray(group.familyAxes) ? group.familyAxes as string[] : [])
    const sending = [parent, ...rows.filter(row => row.parentId !== null && group.includedIds.has(row.id))]
    const levels = ebayListingLevelValues({ rows: sending.map(row => ({ productId: row.id, sku: row.sku, isParent: row === parent })), fields, axes,
      valueOf: (row, field) => rows.find(r => r.id === row.productId)?.values[field.key]?.value })
    for (const field of fields.filter(field => isEbayListingLevel(field, axes))) {
      const level = levels.find(entry => entry.field.key === field.key)
      // With no value anywhere, the listing's (empty) value lives on its parent row.
      const from = level ? { productId: level.supplier.productId, sku: level.supplier.sku } : { productId: parent.id, sku: parent.sku }
      const source = rows.find(row => row.id === from.productId)!.values[field.key]
      for (const row of rows) {
        const cell = row.values[field.key]
        if (!cell) continue
        const variation = row.parentId !== null
        if (row.id === from.productId) {
          if (cell.mapped) cell.mapped.listingLevel = { ...from, ...(variation ? { variation: true as const } : {}) }
          if (variation) Object.assign(cell, { layer: 'alias', pinned: false, resettable: false })
          continue
        }
        const differs = !!level && !isBlankValue(cell.value) && !sameEbayValue(cell.value, source.value)
        const mark: ListingLevelMark = { ...from, ...(variation ? { variation: true as const } : {}), ...(differs ? { ownValue: cell.value } : {}) }
        const shown = source?.mapped ?? cell.mapped
        // The parent row holds nothing here (else it would supply the value): it shows the variation's value eBay gets.
        row.values[field.key] = { ...cell, value: level ? source.value : cell.value, inherited: true, inheritedFrom: from.productId, pinned: false,
          ...(variation ? { layer: 'alias', resettable: false } : {}),
          // The row's own different value is named once, by the cell's source (`listingLevel.ownValue`), not again here.
          mapped: shown ? { ...shown, errors: [...shown.errors], warnings: [...shown.warnings], listingLevel: mark }
            : { value: cell.value, warnings: [], errors: [], listingLevel: mark } }
      }
    }
  }
}

/**
 * Wave 2 (C6, Owner decision 3) — on an Inventory-model listing these stay per variation: eBay takes each variation's
 * condition and package from that variation's own inventory item, not from the main row.
 */
export const EBAY_INVENTORY_PER_VARIATION_FIELDS: ReadonlySet<string> = new Set([
  'conditionId', 'packageType', 'packageWeight', 'weightUnit', 'packageLength', 'packageWidth', 'packageHeight', 'dimensionUnit',
])

interface HeldCellLike extends SheetCellLike {
  source?: string | null
  follows?: boolean | null
  editable?: boolean
  writable?: boolean
  writeBlockedReason?: string | null
  formula?: string
  formulaError?: string
  dependsOn?: string[]
}
interface HeldRowLike { id: string; sku: string; parentId: string | null; aliasId?: string | null; values: Record<string, HeldCellLike> }

const isMeasure = (value: unknown): value is { value?: unknown; unit?: unknown } => !!value && typeof value === 'object' && !Array.isArray(value)
/** Two cell values say the same thing (a measure by its number and unit; anything else as `sameEbayValue`). */
function sameHeldValue(a: unknown, b: unknown): boolean {
  if (isBlankValue(a) && isBlankValue(b)) return true
  if (isMeasure(a) || isMeasure(b)) {
    const norm = (v: unknown) => isMeasure(v) ? [String(v.value ?? '').trim(), String(v.unit ?? '')] : [String(v ?? '').trim(), '']
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b))
  }
  return sameEbayValue(a, b)
}
/** A cell value in words, for the sentence that names a row's own value. */
function heldWords(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.filter(member => !isBlankValue(member)).map(heldWords).join(', ')
  if (isMeasure(value)) return [value.value, value.unit].filter(part => !isBlankValue(part)).map(String).join(' ')
  return String(value).trim()
}

/**
 * Wave 2 (C6) — eBay Trading takes a variation listing's item-level fields (`EBAY_ITEM_LEVEL_FIELDS`: condition, category,
 * policies, location, VAT, Best Offer, max per buyer, package…) ONCE, from its main row (`buildSharedListingInput` reads
 * the parent row; `ebayPublicationXml` the parent's settings). A variation row's own value was shown and editable, and
 * never sent. Now each variation row of a listing with a main row shows the MAIN row's value, read-only, with the reason
 * (and the row's own different value, named, which eBay does not get). Display only: nothing stored or sent changes.
 *
 * The main row's cell is marked `mapped.listingLevel` (no `variation`), so the sheet repaints the variation rows after a
 * save there (`adoptFamilyListings`). Variation cells carry no mark: they are not edited, so they need none.
 * Title, description and the variation theme are not touched (listing columns). On an Inventory-model listing
 * (`inventoryAliases`) condition and package stay per variation (`EBAY_INVENTORY_PER_VARIATION_FIELDS`).
 * Each listing (primary, alias) is held to its OWN main row. A listing of one row (a single product) is left alone.
 */
export function holdEbayItemLevelOnVariations(input: { rows: HeldRowLike[]; columns: SheetColumnLike[]; label: string; inventoryAliases?: ReadonlySet<string> }) {
  const fields = input.columns.flatMap(col => {
    const store = col.channels?.[input.label]?.store as Store
    return store?.kind === 'platformAttributes' && isEbayItemLevel(store) ? [{ key: col.key, field: store.path![0] }] : []
  })
  if (!fields.length) return
  const groups = new Map<string, HeldRowLike[]>()
  for (const row of input.rows) {
    const key = row.aliasId ?? ''
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  for (const [aliasKey, rows] of groups) {
    const main = rows.find(row => row.parentId === null)
    if (!main || rows.length < 2) continue
    const inventory = input.inventoryAliases?.has(aliasKey) ?? false
    for (const { key, field } of fields) {
      if (inventory && EBAY_INVENTORY_PER_VARIATION_FIELDS.has(field)) continue
      const source = main.values[key]
      if (!source) continue
      const head = `eBay takes this once per listing, from the main row ${main.sku}.`
      // A field the main row cannot change either says why there (the listing's reason), never "change it there".
      const there = source.editable === false ? source.writeBlockedReason?.trim() ? ` ${source.writeBlockedReason.trim()}` : '' : ' Change it there.'
      const { listingLevel: _mark, ...shown } = source.mapped ?? { warnings: [], errors: [] }
      for (const row of rows) {
        if (row === main) continue
        const cell = row.values[key]
        if (!cell) continue
        const own = !isBlankValue(cell.value) && !sameHeldValue(cell.value, source.value) ? ` This row also has "${heldWords(cell.value)}", which eBay does not get.` : ''
        const { formula: _formula, formulaError: _formulaError, dependsOn: _dependsOn, ...rest } = cell
        row.values[key] = {
          ...rest,
          // The main row's cell as it is: its value and where that value comes from.
          value: source.value, source: source.source, layer: source.layer, inherited: source.inherited, inheritedFrom: source.inheritedFrom,
          pinned: source.pinned, follows: source.follows,
          // Its problems are named once, on the main row (`judgeEbayItemLevelOnMainRow`).
          mapped: source.mapped ? { ...shown, warnings: [...(shown.warnings ?? [])], errors: [], ...('mappingErrors' in shown ? { mappingErrors: [] } : {}),
            ...('requiredByRule' in shown ? { requiredByRule: false } : {}) } : null,
          editable: false, writable: false, resettable: false,
          writeBlockedReason: `${head}${there}${own}`,
        }
      }
      if (source.mapped) source.mapped.listingLevel = { productId: main.id, sku: main.sku }
    }
  }
}
