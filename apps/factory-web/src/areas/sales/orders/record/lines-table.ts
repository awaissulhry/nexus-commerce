import { parsePrice } from '../../quotes/model'
import type { StyleDetail } from '../../quotes/api'
import type { Order, OrderLine } from '../api'
import type { CellFloors } from '../daily-model'
import type { Freeze, FreezeStage } from '../depth/api'
import type { OrderAbilities } from '../model'
import { baseSizesOf, cellOf, goodsLines, piecesOfLine, piecesOfNew, typeable, type LinesDraft, type NewLine } from './lines-draft'
import { lineMovesShown } from './line-moves'

/**
 * F-OL-01 (d) (Order LINES lane, plan v2 §1; 10-design-tab §1–§10) — the Lines tab's table and totals, pure: who sees which column
 * (the money wall per cell: prices only with the price grain), Ready by only when a line has its own date, one card per style with
 * its colour rows (new rows of the draft at the end of their style's card, a new style as a card of its own), each cell's value, its
 * mark ("was 3"), its floor ("min 3" only where cut or shipped binds) and its company lock; the head's figures, a closed line's
 * "10 ordered · 9 to make · 1 cancelled", a made-to-measure unit's "1 unit · base size 52", the charges, and the totals in plain
 * words by the order's tax basis. No fetching, no React: lines-table.vitest.test.ts holds it.
 */

// ---- who sees what ---------------------------------------------------------------------------------------------------------------

export interface LinesReader {
  /** Types in the table (orders.manage): thin boxes, the save bar, Add a style. */
  readonly writes: boolean
  /** Sees prices (money.price): Unit price, Line total, the totals. */
  readonly prices: boolean
  /** Sales: one line why prices are hidden (writes, no prices). */
  readonly salesHint: boolean
  /** Has a row ⋯ (F6): who changes lines, who makes work orders, Finance. */
  readonly moves: boolean
}

export const linesReaderOf = (can: OrderAbilities): LinesReader => ({ writes: can.manage, prices: can.price, salesHint: can.manage && !can.price, moves: lineMovesShown(can) })

/** Ready by is a column only when some goods line has its own date (adaptive: no "As the order" noise). */
export const ownDatesOf = (order: Pick<Order, 'lines' | 'promiseDate'>): boolean => goodsLines(order).some((line) => line.promiseDate !== null && line.promiseDate !== order.promiseDate)

export type ColumnKey = 'colour' | 'size' | 'plus' | 'pieces' | 'unitPrice' | 'lineTotal' | 'readyBy' | 'more'
export interface Column {
  readonly key: ColumnKey
  /** A size column's size. */
  readonly size?: string
}

/** The columns of a style's table, in order (Colour | sizes | + Size | Pieces | Unit price | Line total | Ready by | ⋯). */
export function columnsOf(reader: LinesReader, sizes: readonly string[], readyBy: boolean): Column[] {
  return [
    { key: 'colour' },
    ...sizes.map((size) => ({ key: 'size' as const, size })),
    ...(reader.writes ? [{ key: 'plus' as const }] : []),
    { key: 'pieces' },
    ...(reader.prices ? [{ key: 'unitPrice' as const }, { key: 'lineTotal' as const }] : []),
    ...(readyBy ? [{ key: 'readyBy' as const }] : []),
    ...(reader.moves ? [{ key: 'more' as const }] : []),
  ]
}

// ---- the cards -----------------------------------------------------------------------------------------------------------------

export type CardRow =
  | { readonly kind: 'line'; readonly key: string; readonly line: OrderLine; readonly removed: boolean; readonly typeable: boolean }
  | { readonly kind: 'new'; readonly key: string; readonly row: NewLine }

export interface StyleCardModel {
  readonly styleId: string
  readonly code: string
  readonly name: string
  readonly revision: { readonly revision: number; readonly status: string } | null
  readonly rows: readonly CardRow[]
  /** The card's size columns, in the style's order when read (else as its lines hold them). */
  readonly sizes: readonly string[]
  /** Every colour row is removed in the draft: "This style leaves the order". */
  readonly leaves: boolean
  /** A new style (no saved line yet). */
  readonly fresh: boolean
}

/** The sizes of a card: its lines' own, the new rows', "+ Size" ones; in the style's range order when the style was read. */
function sizesOfCard(lines: readonly OrderLine[], added: readonly NewLine[], extra: readonly string[], style: StyleDetail | null | undefined): string[] {
  const found: string[] = []
  const take = (size: string) => {
    if (!found.includes(size)) found.push(size)
  }
  for (const line of lines) for (const size of line.sizes) if (size.size !== null) take(size.size)
  for (const row of added) for (const size of Object.keys(row.sizes)) take(size)
  for (const size of extra) take(size)
  const order = style?.matrix.sizes.map((size) => size.code) ?? style?.sizes ?? null
  if (!order) return found
  const rank = (size: string) => {
    const at = order.indexOf(size)
    return at < 0 ? order.length + found.indexOf(size) : at
  }
  return [...found].sort((a, b) => rank(a) - rank(b))
}

/** One card per style (the order's sequence), its rows (new rows last), a new style's card at the end. */
interface CardSoFar {
  styleId: string
  code: string
  name: string
  revision: StyleCardModel['revision']
  lines: OrderLine[]
  added: NewLine[]
}

export function styleCardsOf(order: Pick<Order, 'lines'>, draft: LinesDraft, styles: Readonly<Record<string, StyleDetail | null | undefined>> = {}): StyleCardModel[] {
  const cards = new Map<string, CardSoFar>()
  for (const line of goodsLines(order)) {
    const card: CardSoFar = cards.get(line.styleId) ?? { styleId: line.styleId, code: line.style?.code ?? '—', name: line.style?.name ?? '', revision: line.styleRevision, lines: [], added: [] }
    card.lines.push(line)
    cards.set(line.styleId, card)
  }
  for (const row of draft.added) {
    const card: CardSoFar = cards.get(row.styleId) ?? { styleId: row.styleId, code: row.style.code, name: row.style.name, revision: null, lines: [], added: [] }
    card.added.push(row)
    cards.set(row.styleId, card)
  }
  return [...cards.values()].map((card) => {
    const rows: CardRow[] = [
      ...card.lines.map((line) => ({ kind: 'line' as const, key: line.id, line, removed: !!draft.lines[line.id]?.removed, typeable: typeable(line) })),
      ...card.added.map((row) => ({ kind: 'new' as const, key: row.key, row })),
    ]
    const leaves = card.lines.length > 0 && rows.every((row) => row.kind === 'line' && row.removed)
    return { styleId: card.styleId, code: card.code, name: card.name, revision: card.revision, rows, sizes: sizesOfCard(card.lines, card.added, draft.sizes[card.styleId] ?? [], styles[card.styleId]), leaves, fresh: card.lines.length === 0 }
  })
}

/** "Pattern v3 · approved" / "not approved yet" / chosen by production. */
export type PatternWords = { readonly kind: 'approved' | 'notApproved'; readonly revision: number } | { readonly kind: 'none' }
export const patternOf = (revision: StyleCardModel['revision']): PatternWords => (revision ? { kind: revision.status === 'RELEASED' ? 'approved' : 'notApproved', revision: revision.revision } : { kind: 'none' })

// ---- one cell --------------------------------------------------------------------------------------------------------------------

/** A company lock on a cell (or on a line's price): a change goes to the customer to accept, or it never changes. */
export interface CellLock {
  readonly state: 'CHANGE_REQUEST' | 'BLOCKED'
  readonly stage: FreezeStage | null
}

export interface CellModel {
  /** The colour does not offer the size: "–", never a box. */
  readonly offered: boolean
  readonly value: number
  /** The order's value when I changed it ("was 3"); null: not changed. */
  readonly was: number | null
  /** "min 3": the lowest it may go where cut or shipped binds (never a 0). */
  readonly floor: { readonly count: number; readonly by: 'shipped' | 'cut' } | null
  readonly lock: CellLock | null
}

/** The sizes a colour row offers: what it holds, and the style's offer for that colourway when the style was read. */
export function offeredOf(row: CardRow, style: StyleDetail | null | undefined): readonly string[] | null {
  const colourwayId = row.kind === 'line' ? row.line.colourwayId : row.row.colourwayId
  const offer = style?.colourways.find((entry) => entry.id === colourwayId)?.offeredSizes ?? null
  const holds = row.kind === 'line' ? Object.keys(baseSizesOf(row.line)) : Object.keys(row.row.sizes)
  return offer ? [...new Set([...offer, ...holds])] : null
}

/** A freeze rule's verdict on one size of a line (the company's lock, said on the cell before typing). */
export function cellLockOf(freeze: Freeze | null | undefined, lineId: string, size: string): CellLock | null {
  const cell = freeze?.lines.find((line) => line.lineId === lineId)?.sizes.find((entry) => entry.size === size)
  return cell && cell.locked && cell.state !== 'OPEN' ? { state: cell.state, stage: cell.stage } : null
}

/** A freeze rule's verdict on a line's price. */
export function priceLockOf(freeze: Freeze | null | undefined, lineId: string): CellLock | null {
  const verdict = freeze?.lines.find((line) => line.lineId === lineId)?.fields.find((field) => field.field === 'PRICE')
  return verdict && verdict.state !== 'OPEN' ? { state: verdict.state, stage: verdict.frozenFrom } : null
}

/** The sizes of a style's lines a rule locks, for the card's ONE lock line ("🔒 2 sizes locked by your company's rules"). */
export function locksOfCard(card: Pick<StyleCardModel, 'rows'>, freeze: Freeze | null | undefined): { readonly lineId: string; readonly size: string; readonly lock: CellLock }[] {
  const out: { lineId: string; size: string; lock: CellLock }[] = []
  for (const row of card.rows) {
    if (row.kind !== 'line') continue
    for (const size of row.line.sizes) {
      if (size.size === null) continue
      const lock = cellLockOf(freeze, row.line.id, size.size)
      if (lock) out.push({ lineId: row.line.id, size: size.size, lock })
    }
  }
  return out
}

export function cellOfRow(row: CardRow, size: string, input: { readonly draft: LinesDraft; readonly offered: readonly string[] | null; readonly floors?: CellFloors; readonly freeze?: Freeze | null }): CellModel {
  if (row.kind === 'new') {
    const value = row.row.sizes[size] ?? 0
    return { offered: input.offered === null || input.offered.includes(size), value, was: null, floor: null, lock: null }
  }
  const line = row.line
  const base = baseSizesOf(line)
  // A size the line holds is offered; another one only when the style read says the colourway is made in it (never guessed).
  const offered = size in base || (input.offered !== null && input.offered.includes(size))
  const value = cellOf(input.draft, line, size)
  const typed = input.draft.lines[line.id]?.sizes?.[size]
  const was = typed !== undefined && !row.removed && typed !== (base[size] ?? 0) ? (base[size] ?? 0) : null
  const own = input.floors?.[line.id]?.[size]
  const floorCount = Math.max(own?.cut ?? 0, own?.shipped ?? 0)
  const floor = floorCount > 0 ? { count: floorCount, by: (own?.shipped ?? 0) >= (own?.cut ?? 0) ? ('shipped' as const) : ('cut' as const) } : null
  return { offered, value, was, floor, lock: cellLockOf(input.freeze, line.id, size) }
}

// ---- a row's money (price readers only) ----------------------------------------------------------------------------------------

const cents = (price: string | null | undefined): number | null => {
  if (price === null || price === undefined || price === '') return null
  const number = Number(price)
  return Number.isFinite(number) ? Math.round(number * 100) : null
}

/** The unit price a row shows: what I typed (when it is a price), else the saved one; a new row: typed, else the list's (null). */
export function unitPriceOf(row: CardRow, draft: LinesDraft): string | null {
  if (row.kind === 'new') return parsePrice(row.row.price)
  const typed = draft.lines[row.line.id]?.price
  return (typed !== undefined ? parsePrice(typed) : null) ?? row.line.unitPrice ?? null
}

/**
 * A row's line total in minor units: as the server priced it while I changed nothing of it; else the same arithmetic on my cells
 * (each size × its own price, else the line's) — an estimate the Review window replaces with the server's figures. null: unknown
 * (no price to multiply: a new row on the customer's list price).
 */
export function lineAmountOf(row: CardRow, draft: LinesDraft): { readonly now: number | null; readonly was: number | null } {
  if (row.kind === 'new') {
    const price = cents(parsePrice(row.row.price))
    return { now: price === null ? null : piecesOfNew(row.row) * price, was: null }
  }
  const line = row.line
  const saved = line.netAmount ?? null
  const edit = draft.lines[line.id]
  if (!edit || row.removed || line.kind !== 'SIZE_GRID' || (!edit.sizes && edit.price === undefined)) return { now: saved, was: null }
  const typed = edit.price !== undefined ? cents(parsePrice(edit.price)) : null
  const linePrice = typed ?? cents(line.unitPrice)
  if (linePrice === null) return { now: saved, was: null }
  let total = 0
  for (const size of line.sizes) {
    if (size.size === null) continue
    const own = typed === null ? cents(size.unitPrice ?? null) : null
    total += cellOf(draft, line, size.size) * (own ?? linePrice)
  }
  for (const [size, pieces] of Object.entries(edit.sizes ?? {})) if (!line.sizes.some((entry) => entry.size === size)) total += pieces * linePrice
  return { now: total, was: total !== saved ? saved : null }
}

/** "{n} sizes priced apart": the sizes whose own price differs from the line's (price readers). */
export const sizesPricedApart = (line: Pick<OrderLine, 'sizes' | 'unitPrice'>): number => line.sizes.filter((size) => size.unitPrice != null && line.unitPrice !== undefined && Number(size.unitPrice) !== Number(line.unitPrice)).length

// ---- the head, a closed line, a made-to-measure unit, notes ---------------------------------------------------------------------

export interface LinesHead {
  /** Pieces to make (ordered less closed with fewer), now with my draft, and as saved when it differs. */
  readonly pieces: number
  readonly piecesWas: number | null
  /** Goods lines (charges are counted on their own). */
  readonly lines: number
  readonly charges: number
}

export function headOf(order: Pick<Order, 'lines'>, draft: LinesDraft): LinesHead {
  const goods = goodsLines(order)
  const saved = goods.reduce((sum, line) => sum + line.quantity - (line.closedShort?.quantity ?? 0), 0)
  const now = goods.reduce((sum, line) => sum + (draft.lines[line.id]?.removed ? 0 : piecesOfLine(draft, line) - (line.closedShort?.quantity ?? 0)), 0) + draft.added.reduce((sum, line) => sum + piecesOfNew(line), 0)
  const kept = goods.filter((line) => !draft.lines[line.id]?.removed).length + draft.added.length
  return { pieces: now, piecesWas: now !== saved ? saved : null, lines: kept, charges: order.lines.filter((line) => line.kind === 'FEE').length }
}

/** "10 ordered · 9 to make · 1 cancelled" (pieces only; "not billed" money is a later job). */
export function closedFiguresOf(line: Pick<OrderLine, 'quantity' | 'closedShort'>): { readonly ordered: number; readonly make: number; readonly cancelled: number } | null {
  if (!line.closedShort) return null
  const cancelled = line.closedShort.quantity
  return { ordered: line.quantity, make: Math.max(0, line.quantity - cancelled), cancelled }
}

/** A made-to-measure unit: "1 unit · base size 52" (its size and price stay; only its notes change here). */
export const mtmOf = (line: Pick<OrderLine, 'kind' | 'baseSize' | 'quantity'>): { readonly units: number; readonly baseSize: string | null } | null => (line.kind === 'MADE_TO_MEASURE' ? { units: line.quantity, baseSize: line.baseSize } : null)

/** The quiet notes line: how many notes (on the order, for the floor) and files the row holds, with my draft's text. */
export function notesOf(row: CardRow, draft: LinesDraft): { readonly notes: number; readonly files: number; readonly description: string; readonly note: string } {
  if (row.kind === 'new') return { notes: (row.row.description.trim() ? 1 : 0) + (row.row.note.trim() ? 1 : 0), files: 0, description: row.row.description, note: row.row.note }
  const edit = draft.lines[row.line.id]
  const description = edit?.description ?? row.line.description ?? ''
  const note = edit?.note ?? row.line.note ?? ''
  return { notes: (description.trim() ? 1 : 0) + (note.trim() ? 1 : 0), files: row.line.artwork?.length ?? row.line.artworkCount ?? 0, description, note }
}

// ---- charges and totals (price readers) ---------------------------------------------------------------------------------------

export interface ChargeRow {
  readonly id: string
  /** DEVELOPMENT / SAMPLE / TOOLING when the read says it; null: "Charge". */
  readonly kind: string | null
  readonly forStyle: string | null
  readonly amount: number | null
}

export const chargesOf = (order: Pick<Order, 'lines'>): ChargeRow[] =>
  [...order.lines]
    .filter((line) => line.kind === 'FEE')
    .sort((a, b) => a.seq - b.seq)
    .map((line) => ({ id: line.id, kind: line.feeKind ?? null, forStyle: line.style?.code ?? null, amount: line.netAmount ?? null }))

/** The order's tax basis, read from its own figures (the no-VAT company switch is a later job). */
export type TaxBasis = { readonly kind: 'gross'; readonly rate: string | null } | { readonly kind: 'vat'; readonly rate: string } | { readonly kind: 'vatNone'; readonly nature: string }

export function taxBasisOf(order: Pick<Order, 'priceBasis' | 'lines' | 'vatAmount'>): TaxBasis {
  const goods = goodsLines(order)
  const rated = goods.find((line) => Number(line.vatRatePct) > 0)
  if (order.priceBasis === 'GROSS') return { kind: 'gross', rate: rated ? rated.vatRatePct : null }
  const nature = goods.find((line) => line.vatNature)?.vatNature ?? null
  if (!rated && nature) return { kind: 'vatNone', nature }
  return { kind: 'vat', rate: rated?.vatRatePct ?? goods[0]?.vatRatePct ?? '0' }
}

/** A VAT nature code in words ("export outside the EU"); the code itself only in a tooltip. */
export const natureKindOf = (nature: string): 'export' | 'intraEu' | 'other' => (nature.startsWith('N3.1') ? 'export' : nature.startsWith('N3.2') ? 'intraEu' : 'other')

export interface TotalRow {
  readonly key: 'subtotal' | 'vat' | 'vatNone' | 'total' | 'ofWhichVat'
  readonly amount: number | null
  readonly was: number | null
  readonly grand?: boolean
}

/**
 * The totals block, under Line total: VAT net — Subtotal (excl. VAT) · VAT 22 % · Total (VAT incl.); no VAT on the sale — Subtotal ·
 * VAT: none · Total; a consumer's gross — Total (VAT incl.) · of which VAT. With my draft the net moves by my rows' estimates (the
 * same arithmetic as the server: pieces × price; the VAT at the order's rate) with "was" beside it; the Review window says the
 * server's figures.
 */
export function totalsOf(order: Pick<Order, 'priceBasis' | 'lines' | 'netAmount' | 'vatAmount' | 'grossAmount'>, draft: LinesDraft, cards: readonly StyleCardModel[]): TotalRow[] {
  const basis = taxBasisOf(order)
  const savedNet = order.netAmount ?? null
  let delta = 0
  let known = true
  for (const card of cards)
    for (const row of card.rows) {
      if (row.kind === 'line' && row.removed) {
        delta -= row.line.netAmount ?? 0
        continue
      }
      const amount = lineAmountOf(row, draft)
      if (row.kind === 'new') {
        if (amount.now === null) known = known && piecesOfNew(row.row) === 0
        else delta += amount.now
      } else if (amount.was !== null && amount.now !== null) delta += amount.now - amount.was
    }
  const moved = delta !== 0 && known && savedNet !== null
  const net = moved ? savedNet! + delta : savedNet
  if (basis.kind === 'gross') return [{ key: 'total', amount: order.grossAmount ?? null, was: null, grand: true }, { key: 'ofWhichVat', amount: order.vatAmount ?? null, was: null }]
  if (basis.kind === 'vatNone') return [{ key: 'subtotal', amount: net, was: moved ? savedNet : null }, { key: 'vatNone', amount: 0, was: null }, { key: 'total', amount: net, was: moved ? savedNet : null, grand: true }]
  const vat = moved ? Math.round((net! * Number(basis.rate)) / 100) : (order.vatAmount ?? null)
  const gross = moved ? net! + vat! : (order.grossAmount ?? null)
  return [
    { key: 'subtotal', amount: net, was: moved ? savedNet : null },
    { key: 'vat', amount: vat, was: moved ? (order.vatAmount ?? null) : null },
    { key: 'total', amount: gross, was: moved ? (order.grossAmount ?? null) : null, grand: true },
  ]
}

/** The head's order total (price readers): the totals' grand row. */
export const orderTotalOf = (rows: readonly TotalRow[]): TotalRow | null => rows.find((row) => row.grand) ?? null

// ---- the doors land on a cell -------------------------------------------------------------------------------------------------

/** A size box's id (the doors focus it: Overview's ⋯, the band's "Change the lines"). */
export const cellId = (key: string, size: string): string => `lines-cell-${key}-${size}`
/** A row's Unit price box (Money › "Change our price ›" focuses it). */
export const priceCellId = (key: string): string => `lines-price-${key}`

/** The first box of a row (its first offered size), else its price box; null: nothing typeable. */
export function firstBoxOf(row: CardRow, sizes: readonly string[], offered: readonly string[] | null): string | null {
  if (row.kind === 'line' && (!row.typeable || row.removed)) return null
  const size = sizes.find((entry) => offered === null || offered.includes(entry)) ?? null
  return size ? cellId(row.key, size) : null
}
