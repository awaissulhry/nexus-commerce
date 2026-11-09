import type { Locale } from '../../../lib/i18n/locales'
import { isRange, type CatalogueRead, type RangeFilter, type StyleCard, type StyleDetail } from './api'

/**
 * The Catalogue (B-W2b-194; design portal.customer.catalogue, SCR-226), pure: the page's address and its filters, the
 * chips in use, a style's name in the page's language, its PPE category and product type as keys of our catalogue (the
 * API's English words are dropped), why "Add to order" or "Start an order" cannot act, and the J / K walk of the detail.
 */

export const NS = 'portal-ordering'

export const VIEWS = ['cards', 'list'] as const
export type CatalogueViewMode = (typeof VIEWS)[number]

export interface CatalogueFilters {
  q: string
  category: string | null
  season: string | null
  ppe: string | null
  range: RangeFilter
}

export const NO_FILTERS: CatalogueFilters = { q: '', category: null, season: null, ppe: null, range: 'ALL' }

/** The filters an address holds (`?q=&category=&season=&ppe=&range=`). */
export function filtersOf(search: { get: (name: string) => string | null } | null): CatalogueFilters {
  const text = (name: string) => {
    const value = search?.get(name)?.trim() ?? ''
    return value === '' ? null : value.slice(0, 80)
  }
  const range = search?.get('range')
  return { q: text('q') ?? '', category: text('category'), season: text('season'), ppe: text('ppe'), range: isRange(range) ? range : 'ALL' }
}

/** `/p/<party>/catalogue?…` with the filters, the view and the style on show. */
export function catalogueHref(prefix: string, filters: CatalogueFilters, extra: { view?: CatalogueViewMode | null; style?: string | null } = {}): string {
  const search = new URLSearchParams()
  if (filters.q.trim() !== '') search.set('q', filters.q.trim())
  if (filters.category) search.set('category', filters.category)
  if (filters.season) search.set('season', filters.season)
  if (filters.ppe) search.set('ppe', filters.ppe)
  if (filters.range !== 'ALL') search.set('range', filters.range)
  if (extra.view && extra.view !== 'cards') search.set('view', extra.view)
  if (extra.style) search.set('style', extra.style)
  const text = search.toString()
  return `${prefix}/catalogue${text ? `?${text}` : ''}`
}

export const viewOf = (value: string | null | undefined): CatalogueViewMode => (value === 'list' ? 'list' : 'cards')

/** How many filters are on (the phone's "Filters (n)"; the search is its own field). */
export const filterCount = (filters: CatalogueFilters): number => [filters.category, filters.season, filters.ppe].filter(Boolean).length + (filters.range !== 'ALL' ? 1 : 0)

export const filtered = (filters: CatalogueFilters): boolean => filterCount(filters) > 0 || filters.q.trim() !== ''

/** The style's name in the page's language (its translation when it has one). */
export const styleName = (style: Pick<StyleCard, 'name' | 'nameI18n'>, locale: Locale): string => style.nameI18n?.[locale]?.trim() || style.name

const PPE_KEYS: Readonly<Record<string, string>> = {
  NOT_PPE: 'ppe.none',
  NONE: 'ppe.none',
  CATEGORY_I: 'ppe.cat1',
  CAT_I: 'ppe.cat1',
  CATEGORY_II: 'ppe.cat2',
  CAT_II: 'ppe.cat2',
  CATEGORY_III: 'ppe.cat3',
  CAT_III: 'ppe.cat3',
}
/** The PPE category's key in our catalogue (an unknown code: the generic "PPE"). */
export const ppeKey = (category: string): string => PPE_KEYS[category] ?? 'ppe.other'
export const isPpe = (category: string): boolean => ppeKey(category) !== 'ppe.none'

const TYPES = new Set(['JACKET', 'TROUSERS', 'SUIT', 'GLOVES', 'VEST', 'OTHER'])
/** The product type's key in our catalogue. */
export const typeKey = (type: string): string => (TYPES.has(type) ? `type.${type}` : 'type.OTHER')

/** The PPE line of a style: category, then the standard and class when it has them. */
export function ppeWords(ppe: StyleCard['ppe'], t: (key: string, params?: Readonly<Record<string, string | number>>) => string): string {
  const head = t(ppeKey(ppe.category))
  const tail = [ppe.standard, ppe.class ? t('ppe.class', { class: ppe.class }) : null].filter(Boolean).join(' · ')
  return tail ? `${head} · ${tail}` : head
}

export interface OrderFacts {
  /** The person may order (portal.orderRequests.manage). */
  mayOrder: boolean
  preview: boolean
  offline: boolean
}

/** Why "Add to order" / "Start an order" cannot act (a key), or null. */
export function orderHeld(facts: OrderFacts): string | null {
  if (!facts.mayOrder) return 'held.mayNotOrder'
  if (facts.preview) return 'held.preview'
  if (facts.offline) return 'held.offline'
  return null
}

/** The ids in the order shown (J / K in the detail walk the results). */
export const resultIds = (read: Pick<CatalogueRead, 'styles'> | null): string[] => (read ? read.styles.map((style) => style.id) : [])

/** The detail's size table: every size of the style's range a colour offers, a mark per colour. */
export function sizeMatrix(detail: StyleDetail['style']): { sizes: string[]; rows: { id: string; label: string; offered: boolean[] }[] } {
  const sizes: string[] = []
  for (const colourway of detail.colourways) for (const row of colourway.sizes) if (!sizes.includes(row.size)) sizes.push(row.size)
  return {
    sizes,
    rows: detail.colourways.map((colourway) => ({ id: colourway.id, label: `${colourway.name} (${colourway.code})`, offered: sizes.map((size) => colourway.sizes.some((row) => row.size === size && row.offered)) })),
  }
}
