import type { BrandRow, ProductRow, ScaleRow, StyleRow } from '../api'
import { storeUrl } from '../../../../record-panels/store'
import type { LooksState } from '../gallery/gallery-model'
import type { DuplicateModel } from '../duplicate/duplicate-model'
import type { DuplicateActions } from '../duplicate/view/DuplicateDialog'
import type { WizardActions } from '../../../admin/import/view/ImportWizard'
import type { CommerceImportActions } from '../import/commerce/commerce-model'
import type { CommerceImportState } from '../import/commerce/use-commerce-import'
import type { PpeValue, RangeValue } from '../forms'
import { moneyText, type Grains, type StyleAbilities, type StyleListView } from '../model'
// B-W2b-236: List · Gallery.
import type { StylesGalleryModel } from '../gallery/gallery-model'
// B-W2b-237 (SCR-343): the release column's completeness and Set season.
import type { ListGate, SeasonResult } from './depth/model'
// B-TH-251: "Add to project" (the bulk bar's button and its dialog).
import type { AddToListPart, AddToProjectActions, AddToRecord } from '../../projects/add-to/model'

export interface StyleFilters {
  view: StyleListView
  q: string
  /** A product type (JACKET …) or '' for every type. */
  type: string
  /** A PPE category or '' for every one. */
  ppe: string
  /** owb-pd4 (step 4.1): the family "Made for ⟨customer⟩" — the customer's party id, or '' (absent) for every product. */
  brand?: string
}

export const NO_FILTERS: StyleFilters = { view: 'open', q: '', type: '', ppe: '', brand: '' }

/** The filters beyond the saved view (the chips in the toolbar). */
export const extraFilterCount = (filters: StyleFilters): number => (filters.q.trim() ? 1 : 0) + (filters.type ? 1 : 0) + (filters.ppe ? 1 : 0) + (filters.brand ? 1 : 0)

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

/** New style › Start from (design pop:styles.new): Blank, Copy of a style (W2a), a Nexus Commerce product (W2b, B-W2b-209); Template (Later) is held. */
export type StartFrom = 'blank' | 'copy' | 'template' | 'commerce'
export const START_FROM: readonly StartFrom[] = ['blank', 'copy', 'template', 'commerce']

// ---- owb-pd4 (step 4.1; design § 5q "Office › Products", prototype prod.js prodList) — the Products list, pure ----------------------

/**
 * The list's columns, in the design's order: the picture first; the agreed price only with the price grain, the margin only with the
 * margin grain (pd1 marks `marginPct` money.margin, as price lists and margins do today: a cost grain alone would give the price away).
 */
export type ProductColumn = 'picture' | 'product' | 'type' | 'status' | 'revision' | 'sizes' | 'protection' | 'orders' | 'price' | 'margin' | 'more'
export function productColumns(grains: Pick<Grains, 'price' | 'margin'>): ProductColumn[] {
  return ['picture', 'product', 'type', 'status', 'revision', 'sizes', 'protection', 'orders', ...(grains.price ? (['price'] as const) : []), ...(grains.margin ? (['margin'] as const) : []), 'more']
}

/** A key of the products catalogue and its params. */
export interface ListWords {
  key: string
  params?: Record<string, string | number>
}

/** The family: the row's own word when the API sends it (pd1), else the customer it is made for (empty: our range). */
export const familyOf = (row: Pick<ProductRow, 'family' | 'brand'>): 'OUR_RANGE' | 'FOR_CUSTOMER' => row.family ?? (row.brand ? 'FOR_CUSTOMER' : 'OUR_RANGE')

/** "Our range" / "Made for ⟨customer⟩". */
export function familyWords(row: Pick<ProductRow, 'family' | 'brand'>): ListWords {
  return familyOf(row) === 'FOR_CUSTOMER' ? { key: 'family.madeFor', params: { customer: row.brand?.name ?? '—' } } : { key: 'family.ourRange' }
}

/** The type: the product type profile's name when set (S4 settle 1: "Hoodie", "Molded part"), else the kind's word. */
export function typeWords(row: Pick<ProductRow, 'typeName' | 'productType'>): { text: string } | ListWords {
  return row.typeName?.trim() ? { text: row.typeName.trim() } : { key: `productType.${row.productType}` }
}

/** The agreed price range (price grain; lowest–highest over every customer's agreed price), or null: none, or not in the role. */
export function agreedText(range: ProductRow['agreedRange'], locale: 'it' | 'en'): string | null {
  if (!range) return null
  const low = moneyText(range.low, range.currency, locale)
  return Number(range.low) === Number(range.high) ? low : `${low} – ${moneyText(range.high, range.currency, locale)}`
}

/** Where the margin comes from: the kept standard cost, or a rough standard of its kind (margin grain). Null: no margin. */
export const marginHintKey = (row: Pick<ProductRow, 'marginPct' | 'marginFrom'>): string | null =>
  row.marginPct == null ? null : row.marginFrom === 'KIND' ? 'list.margin.fromKind' : 'list.margin.fromKept'

/** "S–XXL" / "Made to measure" / "—". */
export function sizesWords(row: Pick<ProductRow, 'sizes' | 'mtmAllowed'>): ListWords | { text: string } {
  if (row.sizes.length > 0) return { text: row.sizes.length === 1 ? row.sizes[0]! : `${row.sizes[0]}–${row.sizes[row.sizes.length - 1]}` }
  return row.mtmAllowed ? { key: 'list.mtm' } : { text: '—' }
}

/** Protection: "CE AA" (the class of a PPE product), "No class yet", or none for a product that is not PPE. */
export function protectionWords(row: Pick<ProductRow, 'ppeCategory' | 'ppeClass'>): ListWords | null {
  if (row.ppeCategory === 'NOT_PPE') return null
  return row.ppeClass ? { key: 'list.protection.ce', params: { class: row.ppeClass } } : { key: 'list.protection.noClass' }
}

/** The main picture of a row from the looks read (the gallery's addresses through this app), or null: none, or not read yet. */
export function pictureSrcOf(looks: LooksState | undefined, styleId: string): string | null {
  const url = looks?.status === 'ready' ? looks.byStyle[styleId]?.picture?.look?.url : undefined
  if (!url) return null
  if (url.startsWith('data:image/')) return url
  try {
    return storeUrl(url)
  } catch {
    return null
  }
}

/** "n things before release": the blockers of a product's open draft, from the release gate's summary (null: no draft, or not read yet). */
export function thingsBefore(row: Pick<ProductRow, 'id' | 'draftRevision'>, gate: ListGate | undefined): number | null {
  const summary = gate?.byStyle[row.id]
  if (row.draftRevision === null || !summary || !summary.checked || summary.revision?.status !== 'DRAFT') return null
  return summary.blockers
}

/** One card of the phone list (under 720 px; 375 px with no sideways scroll): money only with its grain. */
export interface ProductCard {
  id: string
  code: string
  name: string
  picture: string | null
  family: ListWords
  type: { text: string } | ListWords
  sizes: ListWords | { text: string }
  protection: ListWords | null
  orders: number | null
  price: string | null
  margin: { pct: string; hint: string | null } | null
}
export function productCardOf(row: ProductRow, options: { grains: Pick<Grains, 'price' | 'margin'>; looks?: LooksState; locale: 'it' | 'en' }): ProductCard {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    picture: pictureSrcOf(options.looks, row.id),
    family: familyWords(row),
    type: typeWords(row),
    sizes: sizesWords(row),
    protection: protectionWords(row),
    orders: row.openOrders ?? null,
    price: options.grains.price ? agreedText(row.agreedRange ?? null, options.locale) : null,
    margin: options.grains.margin && row.marginPct != null ? { pct: row.marginPct, hint: marginHintKey(row) } : null,
  }
}
// ---- end owb-pd4

export interface StylesListViewModel {
  prefix: string
  can: StyleAbilities
  /** Money grains (A1 §2.6): owb-pd4 — the agreed price needs `price`, the margin (from the kept cost) `cost`. */
  grains: Grains
  /** owb-pd4 (step 4.1): the main picture of each row on screen (the gallery's looks read); absent: no picture column yet. */
  looks?: LooksState
  /** owb-pd4: the customers a product can be made for (the family filter "Made for ⟨customer⟩"); absent or null: no filter. */
  brands?: Array<{ id: string; name: string }> | null
  /** Duplicate style (a row's ⋯, or New style › Start from: Copy of a style). */
  duplicate: DuplicateModel | null
  filters: StyleFilters
  rows: { items: ProductRow[] | null; more: boolean; count: number | null; problem: string | null }
  /** The tiles' counts: null while unknown (drawn "—", never 0). */
  tiles: Partial<Record<StyleListView, number | null>>
  asOf: string | null
  /** Live changes waiting behind "N updates · Show". */
  updates: number
  newStyle: NewStyleModel | null
  /** W2b (B-W2b-209): New style › Nexus Commerce product and the header's Import (its steps and the import wizard). */
  commerce?: CommerceImportState
  /** Why the header's Import is held (a key of `products-commerce-import`), null when it is not. */
  importHeld?: string | null
  busy: boolean
  notice: { key: string; tone: 'info' | 'success' | 'warning' | 'danger'; params?: Record<string, string | number> } | null
  /** Design cases: the rows already selected, the focused row. */
  selected?: string[]
  focusRow?: number
  /** Design cases: the phone card list (below 720 px) drawn whatever the width; its select mode; its filters sheet. */
  phone?: boolean
  phoneSelect?: boolean
  phoneFilters?: boolean
  /** B-W2b-236 (SCR-303): the Gallery view (on, and the looks of the rows on screen); absent: the list. */
  gallery?: StylesGalleryModel
  /** B-W2b-237 (SCR-343): the release gate summed up per row (absent: W1's readiness only). */
  gate?: ListGate
  /** B-W2b-237: Set season's outcome (the pop-up says it), and the design cases' pop-up already open. */
  season?: { result: SeasonResult | null; open?: boolean }
  /** B-TH-251: "Add to project" on the selected styles (absent: no button). */
  addToProject?: AddToListPart
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
  /** New style › Start from: Copy of a style opens the Duplicate dialog on its source picker; a Nexus Commerce product the import's source step. */
  onStartFrom?: (from: StartFrom) => void
  /** W2b (B-W2b-209): the header's Import (a Nexus Commerce export, or a sheet in its columns). */
  onImport?: () => void
  commerce?: CommerceImportActions
  commerceSheet?: WizardActions
  /** A row's ⋯ › Duplicate…. */
  onDuplicate?: (row: StyleRow) => void
  duplicate?: DuplicateActions
  onNewDraft?: (draft: NewStyleDraft) => void
  onCreate?: () => void
  onDismissNotice?: () => void
  /** B-W2b-236: List · Gallery. */
  onGallery?: (on: boolean) => void
  /** B-W2b-237: Set season on the selected styles (null clears it); the pop-up closing clears the outcome. */
  onSetSeason?: (ids: string[], season: string | null) => Promise<void>
  onSeasonClosed?: () => void
  /** B-TH-251: "Add to project" on the selected styles (each by its code), and its dialog. */
  onAddToProject?: (records: AddToRecord[]) => void
  addToProject?: AddToProjectActions
}
