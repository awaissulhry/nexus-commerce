/**
 * "Sells from" (Step 2, Owner 2026-10-07) — the page's pure rules for the From column, its pop-up and the bulk field.
 *
 * Owner decisions: a default per market for the whole business, plus per-product exceptions; the listing shows the SUM
 * of the ticked warehouses; the list order is the SALE order (a sale takes stock from the first that has it); Amazon EU
 * is one choice for the whole EU group (the From column shows once, on `AMAZON:EU`). The normaliser and the checks are
 * the shared ones (`sellsFromCodes`, `sameSourceCodes`, `sourceCodesProblem` — the server runs the same); nothing here
 * re-implements them. Pure: no React, no AG, so the node vitest reaches every rule (`sells-from.vitest.test.ts`).
 */
import { sameSourceCodes, sellsFromCodes, sourceCodesProblem } from './preview'
import {
  MATRIX_COPY,
  type CoordinateKey,
  type MatrixCellKind,
  type MatrixCells,
  type MatrixCoordinate,
  type MatrixLocation,
  type MatrixRowRead,
  type SourceCell,
} from './contract'

/* ── the column ──────────────────────────────────────────────────────────────────────────────── */

export const FROM_COL_W = 176
export const FROM_LABEL = 'From'

/** A market group's From column: `<key>.from`. Not a Matrix cell id (`parseMatrixColId` → null): no cell write reaches it. */
export const matrixFromColId = (key: CoordinateKey): string => `${key}.from`
export const isMatrixFromColId = (colId: string | null | undefined): boolean => !!colId && colId.lastIndexOf('.') > 0 && colId.endsWith('.from')
/** The group a From column belongs to. */
export const fromGroupKey = (colId: string): CoordinateKey => colId.slice(0, colId.lastIndexOf('.'))

/** A group that carries the quantity (its cells include Qty) draws a From column — so once on Amazon EU. */
export const hasMatrixFrom = (coord: Pick<MatrixCoordinate, 'connected' | 'cells'>): boolean => coord.connected && coord.cells.includes('syncQty')

const AFTER_FROM: readonly MatrixCellKind[] = ['syncMode', 'syncQty', 'syncBuffer', 'syncState']
/** The cell the From column is placed before: right after Fulfilment (Fulfilment · From · Mode · Qty · Buffer · Sync). */
export function fromBefore(coord: Pick<MatrixCoordinate, 'connected' | 'cells'>): MatrixCellKind | null {
  return hasMatrixFrom(coord) ? coord.cells.find((k) => AFTER_FROM.includes(k)) ?? null : null
}

/** The words a market goes by in the pop-up and its tooltip: `Amazon EU` for the EU group, else the group's own label. */
export const marketName = (coord: Pick<MatrixCoordinate, 'kind' | 'channel' | 'label'>): string =>
  coord.kind === 'region-inventory' && coord.channel === 'AMAZON' ? 'Amazon EU' : coord.label

/** `IT-MAIN + MI-3PL` */
export const codesText = (codes: readonly string[]): string => codes.join(' + ')

/** The codes a cell sells from now, in sale order. */
export function sellingCodes(src: SourceCell): string[] {
  if (src.effective.length) return src.effective.map((e) => e.code)
  return [...(src.own.length ? src.own : src.marketDefault)]
}

export interface FromView {
  /** What the cell shows. */
  text: string
  /** `own` = this product's own choice (normal weight); `default` = follows the market default (muted); `shared` = a Shared pill; `none` = blank. */
  look: 'own' | 'default' | 'shared' | 'fba' | 'none'
  tooltip: string | undefined
  /** May the pop-up open on it? */
  door: boolean
  /** Why it cannot be changed (an open gesture says it); null = it can, or there is nothing to say. */
  held: string | null
}

const NONE: FromView = { text: '', look: 'none', tooltip: undefined, door: false, held: null }

/** The From cell's tooltip: where it sells from, in order, with this SKU's units; whose choice it is; the rule once. */
export function fromTooltip(src: SourceCell, where: string): string {
  const units = new Map(src.effective.map((e) => [e.code.toUpperCase(), e.available]))
  const codes = sellingCodes(src)
  if (codes.length === 0) return `No warehouse sells on ${where}.`
  const list = codes.map((c) => `${c} (${units.get(c.toUpperCase()) ?? 0})`).join(', then ')
  const whose = src.own.length ? 'this product\'s own choice' : `the ${where} default`
  const rule = codes.length > 1 ? '\nListings show the sum; a sale takes stock from the first that has it.' : ''
  return `Sells from ${list} — ${whose}.${rule}`
}

/** The From cell of a row on a group: blank on the parent, `—` on FBA, `Shared` on a SKU that sells another business's stock. */
export function fromCellView(row: Pick<MatrixRowRead, 'role' | 'stock'> | null, cells: MatrixCells | null, coord: Pick<MatrixCoordinate, 'kind' | 'channel' | 'label'>): FromView {
  const src = cells?.source
  if (!row || !src) return NONE
  if (row.role === 'parent') return { ...NONE, held: src.blockedReason ?? MATRIX_COPY.sourceParent }
  if (cells?.sync?.kind === 'FBA_EXCLUDED' || src.blockedReason === MATRIX_COPY.sourceFba) {
    return { text: '—', look: 'fba', tooltip: MATRIX_COPY.sourceFba, door: false, held: MATRIX_COPY.sourceFba }
  }
  if (row.stock.source) {
    const why = src.blockedReason ?? `Sells ${row.stock.source.lenderName}'s stock`
    return { text: 'Shared', look: 'shared', tooltip: why, door: false, held: why }
  }
  const codes = sellingCodes(src)
  return {
    text: codes.length ? codesText(codes) : 'None',
    look: src.own.length ? 'own' : 'default',
    tooltip: fromTooltip(src, marketName(coord)),
    door: src.writable,
    held: src.writable ? null : src.blockedReason,
  }
}

/** The words an export writes for a From cell (what the cell shows; null when blank). */
export function fromCellText(row: Pick<MatrixRowRead, 'role' | 'stock'> | null, cells: MatrixCells | null, coord: Pick<MatrixCoordinate, 'kind' | 'channel' | 'label'>): string | null {
  const v = fromCellView(row, cells, coord)
  return v.look === 'none' ? null : v.text
}

/* ── the picker ──────────────────────────────────────────────────────────────────────────────── */

const key = (c: string) => c.trim().toUpperCase()

/** The warehouses a list may name, in sale order: active only, the business default first, then by code. */
export function activeWarehouses(locations: readonly MatrixLocation[] | undefined): MatrixLocation[] {
  return (locations ?? []).filter((l) => l.active).sort((a, b) => Number(!!b.isDefault) - Number(!!a.isDefault) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
}

/** Codes as the warehouses spell them, unknown and switched-off ones dropped, each once, order kept. */
export function knownCodes(codes: readonly string[], locations: readonly MatrixLocation[]): string[] {
  const byKey = new Map(activeWarehouses(locations).map((l) => [key(l.code), l.code]))
  const out: string[] = []
  for (const c of codes) { const k = byKey.get(key(c)); if (k && !out.includes(k)) out.push(k) }
  return out
}

/** The picker's rows: the ticked codes in sale order, then the other active warehouses (default first, then by code). */
export function pickerOrder(locations: readonly MatrixLocation[], ticked: readonly string[]): string[] {
  const on = knownCodes(ticked, locations)
  return [...on, ...activeWarehouses(locations).map((l) => l.code).filter((c) => !on.includes(c))]
}

/** After a reorder of the picker's rows: the ticked ones, in their new order (an unticked row has no place in a sale). */
export const tickedInOrder = (order: readonly string[], ticked: readonly string[]): string[] => order.filter((c) => ticked.includes(c))

/** Ticking adds a warehouse LAST (it sells after the others); unticking takes it out. */
export const toggleCode = (ticked: readonly string[], code: string): string[] =>
  ticked.includes(code) ? ticked.filter((c) => c !== code) : [...ticked, code]

/* ── the pop-up ──────────────────────────────────────────────────────────────────────────────── */

export type SellsFromScope = 'product' | 'market'

/** Where the pop-up starts: This product = what it sells from now; Every product = the market default. */
export function startingCodes(src: SourceCell, scope: SellsFromScope, locations: readonly MatrixLocation[]): string[] {
  const from = scope === 'market' ? src.marketDefault : src.own.length ? src.own : src.marketDefault
  return knownCodes(from, locations)
}

/** Why Save waits; null = it can save. */
export function saveHeld(scope: SellsFromScope, draft: readonly string[], src: SourceCell, locations: readonly MatrixLocation[]): string | null {
  if (draft.length === 0) return 'Tick at least one warehouse'
  const problem = sourceCodesProblem(draft, locations)
  if (problem) return problem
  if (scope === 'product') return sameSourceCodes(sellsFromCodes(draft, src.marketDefault), src.own) ? 'Nothing to change' : null
  return sameSourceCodes(draft, src.marketDefault) ? 'Nothing to change' : null
}

/** What This product stores: `[]` when the choice is the market default (an exception exists only when it differs). */
export const productCodesToWrite = (draft: readonly string[], src: SourceCell): string[] => sellsFromCodes(draft, src.marketDefault)

/** `Use the default (IT-MAIN)` — offered in This product while the choice differs from the default. */
export function defaultLink(draft: readonly string[], src: SourceCell): string | null {
  if (sameSourceCodes(draft, src.marketDefault) || src.marketDefault.length === 0) return null
  return `Use the default (${codesText(src.marketDefault)})`
}

/** The market the business-default route takes: `EU` for Amazon's EU group (the only way to name it), else the group's market. */
export function marketSourcesTarget(coord: Pick<MatrixCoordinate, 'kind' | 'channel' | 'market'>): { channel: string; marketplace: string } {
  return { channel: coord.channel, marketplace: coord.kind === 'region-inventory' && coord.channel === 'AMAZON' ? 'EU' : coord.market }
}

const n = (count: number, one: string, many: string) => `${count.toLocaleString('en')} ${count === 1 ? one : many}`

/** The dry run's one line: `Changes the default for 18 listings · 2 products keep their own choice`. */
export function dryRunSentence(a: { listings: number; exceptions: number }): string {
  const head = `Changes the default for ${n(a.listings, 'listing', 'listings')}`
  if (a.exceptions <= 0) return head
  return `${head} · ${a.exceptions === 1 ? '1 product keeps its' : `${a.exceptions.toLocaleString('en')} products keep their`} own choice`
}

/** The toast after a This product save. */
export function productSavedSentence(sku: string, where: string, stored: readonly string[], src: SourceCell): string {
  return stored.length ? `${sku} · ${where} sells from ${codesText(stored)}` : `${sku} · ${where} uses the default (${codesText(src.marketDefault)})`
}

/** The toast after an Every product save. */
export const marketSavedSentence = (where: string, codes: readonly string[], listings: number): string =>
  `${where} default: ${codesText(codes)} · ${n(listings, 'listing', 'listings')}`
