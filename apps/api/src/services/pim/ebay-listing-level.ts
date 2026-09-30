/**
 * P1 of fix/product-sheet-editing (report 5 I-1, I-3) — eBay takes ONE value per listing for every item specific that is
 * not a variation axis ("Paese di origine", "Marca", "Stagione", "Colore specifico", "Genere"…). The publisher builds it
 * parent first, then the first variation in SKU order that holds one (`buildSharedListingInput`). These helpers are that
 * rule, so the sheet shows on every row the value eBay receives, a write on any row lands where eBay reads it, and the
 * publish review names the rows whose own value is not sent.
 *
 * The axes are the family's variation projection for the listing — the included axes the publisher itself sends as
 * variation specifics (`buildEbayListingInput`). Per-row values of an aspect that is NOT an axis yet stay stored per row
 * (the Variation theme editor reads them as candidates); only what is shown and written is the listing's one value.
 */
import { aspectCanonicalName } from '../ebay-theme-axes.js'
import { canonicalVariantAxis } from './variant-attribute-keys.js'
import { isBlankValue } from './sheet-values.js'

type Store = { kind: string; path?: string[] } | null | undefined

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

export interface FamilyRow { productId: string; sku: string; isParent: boolean; value: unknown }

/**
 * The row whose value eBay receives: the parent's when it holds one, else the first variation in SKU order that does —
 * the order `buildSharedListingInput` reads (`[parentRow, ...variantRows]`, first value wins). Null when none holds one.
 */
export function ebayFamilySupplier<T extends FamilyRow>(rows: T[]): T | null {
  const ordered = [...rows].sort((a, b) => Number(b.isParent) - Number(a.isParent) || a.sku.localeCompare(b.sku))
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
    const differing = rows.filter(row => row !== supplier && !isBlankValue(row.value) && !sameEbayValue(row.value, supplier.value)).sort((a, b) => a.sku.localeCompare(b.sku))
    out.push({ field, supplier, value: supplier.value, differing })
  }
  return out
}

/**
 * The sentence the publish review shows when rows hold another value (report 5 I-3): eBay takes one value for the whole
 * listing, this one, from this row; these rows' own values are not sent. Bounded to ten rows by name.
 */
export function listingLevelWarning(label: string, value: unknown, fromSku: string, differing: Array<{ sku: string; value: unknown }>): string {
  const shown = (v: unknown) => JSON.stringify(Array.isArray(v) ? v.join(', ') : v)
  const named = differing.slice(0, 10).map(row => `${row.sku} (${shown(row.value)})`).join(', ')
  const more = differing.length > 10 ? ` and ${differing.length - 10} more` : ''
  return `${label}: eBay takes one value for the whole listing and will get ${shown(value)} (from ${fromSku}). `
    + `${differing.length} ${differing.length === 1 ? 'row holds' : 'rows hold'} another value that is not sent: ${named}${more}.`
}

/** What a variation row's cell says about the listing's one value it shows. */
export function listingLevelNote(label: string, ownValue: unknown, value: unknown, fromSku: string): string {
  return `This row holds ${JSON.stringify(ownValue)}, which eBay does not receive: eBay takes one ${label} for the whole listing, ${JSON.stringify(value)} from ${fromSku}. Editing this cell sets the listing's value.`
}

interface SheetCellLike {
  value: unknown
  inherited?: boolean
  inheritedFrom?: string | null
  pinned?: boolean
  mapped?: { value?: unknown; warnings: string[]; errors: string[]; listingLevel?: { productId: string; sku: string; ownValue?: unknown } } | null
}
interface SheetRowLike { id: string; sku: string; parentId: string | null; aliasId?: string | null; values: Record<string, SheetCellLike> }
interface SheetColumnLike { key: string; label: string; channelLabel?: string; channels?: Record<string, { store?: unknown } | undefined> }

/**
 * The sheet's eBay scope shows, on every row of a listing, the listing-level value eBay receives (report 5 I-1): the
 * supplying row's cell, marked `mapped.listingLevel`, and a row whose own stored value differs says so. Runs after the
 * Variation theme cells are built, which read the rows' own values for axis candidates. `groups`: each listing (primary
 * and aliases) with its projection's axes and the variations it sends.
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
    for (const level of levels) {
      const source = rows.find(row => row.id === level.supplier.productId)!.values[level.field.key]
      const from = { productId: level.supplier.productId, sku: level.supplier.sku }
      for (const row of rows) {
        const cell = row.values[level.field.key]
        if (!cell) continue
        if (row.id === from.productId) { if (cell.mapped) cell.mapped.listingLevel = from; continue }
        const differs = !isBlankValue(cell.value) && !sameEbayValue(cell.value, source.value)
        row.values[level.field.key] = { ...cell, value: source.value, inherited: true, inheritedFrom: from.productId, pinned: false,
          mapped: source.mapped ? { ...source.mapped, errors: [...source.mapped.errors],
            warnings: [...source.mapped.warnings, ...(differs ? [listingLevelNote(level.field.label, cell.value, source.value, from.sku)] : [])],
            listingLevel: { ...from, ...(differs ? { ownValue: cell.value } : {}) } } : { value: source.value, warnings: [], errors: [], listingLevel: { ...from, ...(differs ? { ownValue: cell.value } : {}) } } }
      }
    }
  }
}
