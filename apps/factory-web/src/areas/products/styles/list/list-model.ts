import type { BrandRow, PriceEntry, PriceListRow, ScaleRow, StyleRow } from '../api'
import type { DuplicateModel } from '../duplicate/duplicate-model'
import type { DuplicateActions } from '../duplicate/view/DuplicateDialog'
import type { PpeValue, RangeValue } from '../forms'
import type { Grains, StyleAbilities, StyleListView } from '../model'

export interface StyleFilters {
  view: StyleListView
  q: string
  /** A product type (JACKET …) or '' for every type. */
  type: string
  /** A PPE category or '' for every one. */
  ppe: string
}

export const NO_FILTERS: StyleFilters = { view: 'open', q: '', type: '', ppe: '' }

/** The filters beyond the saved view (the chips in the toolbar). */
export const extraFilterCount = (filters: StyleFilters): number => (filters.q.trim() ? 1 : 0) + (filters.type ? 1 : 0) + (filters.ppe ? 1 : 0)

export interface NewStyleDraft {
  companyId: string | null
  code: string
  name: string
  productType: StyleRow['productType']
  season: string
  brandPartyId: string | null
  range: RangeValue
  ppe: PpeValue
  mtmAllowed: boolean
}

export interface NewStyleModel {
  draft: NewStyleDraft
  /** The companies the person works in (a choice only when there are several; '' = every company). */
  companies: Array<{ id: string; name: string }>
  scales: ScaleRow[] | null
  brands: BrandRow[] | null
  busy: boolean
  problem: string | null
  /** The fields the API refused (their paths). */
  refused: string[]
}

/** New style › Start from (design pop:styles.new): Blank, Copy of a style (W2a); Template (Later) and a Nexus Commerce product (W2b) are held. */
export type StartFrom = 'blank' | 'copy' | 'template' | 'commerce'
export const START_FROM: readonly StartFrom[] = ['blank', 'copy', 'template', 'commerce']

/** A style's price in the base list in force (W2a, B-W2a-19): its own price, else the lowest of its colourways ("from"). */
export interface StylePrice {
  price: string | null
  /** Only colourways are priced: the lowest, said "from". */
  from: boolean
  marginPct: string | null
  belowFloor: boolean
}

/**
 * The list prices beside the styles: hidden without pricelists.view or the price grain (the columns are absent), none
 * when no BASE list is in force for the company, else the list and each style's price.
 */
export type ListPrices =
  | { state: 'hidden' }
  | { state: 'loading' }
  | { state: 'none' }
  | { state: 'error'; problem: string }
  | { state: 'ready'; list: { id: string; code: string; name: string; currency: string }; byStyle: Record<string, StylePrice> }

/** The BASE list a company's styles are priced from: its own first, then every company's; euros first. */
export function pickBaseList(lists: readonly PriceListRow[], companyId: string | null): PriceListRow | null {
  const usable = lists.filter((list) => list.kind === 'BASE' && list.state === 'IN_FORCE' && list.shownVersion !== null)
  const rank = (list: PriceListRow) => (list.companyId !== null && list.companyId === companyId ? 0 : list.companyId === null ? 2 : 4) + (list.currency === 'EUR' ? 0 : 1)
  return [...usable].sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code))[0] ?? null
}

/** Each style's price in a version's entries: the style's own row wins; else the lowest colourway row ("from"). */
export function pricesByStyle(entries: readonly PriceEntry[]): Record<string, StylePrice> {
  const out: Record<string, StylePrice> = {}
  const lowest = new Map<string, PriceEntry>()
  for (const entry of entries) {
    if (entry.unitPrice === undefined) continue
    if (entry.colourwayId === null) out[entry.styleId] = { price: entry.unitPrice, from: false, marginPct: entry.marginPct ?? null, belowFloor: entry.belowFloor ?? false }
    else {
      const seen = lowest.get(entry.styleId)
      if (!seen || Number(entry.unitPrice) < Number(seen.unitPrice)) lowest.set(entry.styleId, entry)
    }
  }
  for (const [styleId, entry] of lowest) if (!out[styleId]) out[styleId] = { price: entry.unitPrice ?? null, from: true, marginPct: entry.marginPct ?? null, belowFloor: entry.belowFloor ?? false }
  return out
}

export interface StylesListViewModel {
  prefix: string
  can: StyleAbilities
  /** Money grains: the list price needs `price`, the margin `margin` (A1 §2.6; S2: sales see margin %, never cost). */
  grains: Grains
  prices: ListPrices
  /** Duplicate style (a row's ⋯, or New style › Start from: Copy of a style). */
  duplicate: DuplicateModel | null
  filters: StyleFilters
  rows: { items: StyleRow[] | null; more: boolean; count: number | null; problem: string | null }
  /** The tiles' counts: null while unknown (drawn "—", never 0). */
  tiles: Partial<Record<StyleListView, number | null>>
  asOf: string | null
  /** Live changes waiting behind "N updates · Show". */
  updates: number
  newStyle: NewStyleModel | null
  busy: boolean
  notice: { key: string; tone: 'info' | 'success' | 'warning' | 'danger'; params?: Record<string, string | number> } | null
  /** Design cases: the rows already selected, the focused row. */
  selected?: string[]
  focusRow?: number
  /** Design cases: the phone card list (below 720 px) drawn whatever the width; its select mode; its filters sheet. */
  phone?: boolean
  phoneSelect?: boolean
  phoneFilters?: boolean
}

export interface StylesListActions {
  onFilters?: (filters: StyleFilters) => void
  onRetry?: () => void
  onMore?: () => void
  onShowUpdates?: () => void
  onOpen?: (id: string) => void
  onExport?: (ids: string[]) => void
  onArchiveMany?: (ids: string[], reason: string) => Promise<boolean>
  onNewStyle?: (open: boolean) => void
  /** New style › Start from: Copy of a style opens the Duplicate dialog on its source picker. */
  onStartFrom?: (from: StartFrom) => void
  /** A row's ⋯ › Duplicate…. */
  onDuplicate?: (row: StyleRow) => void
  duplicate?: DuplicateActions
  onNewDraft?: (draft: NewStyleDraft) => void
  onCreate?: () => void
  onDismissNotice?: () => void
}
