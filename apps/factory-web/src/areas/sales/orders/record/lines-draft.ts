import { parsePrice } from '../../quotes/model'
import type { AmendLineInput, Followed, Order, OrderLine } from '../api'
import type { PickBody } from '../../quotes/record/configurator/api'
import type { CellFloors } from '../daily-model'
import type { Phrase } from '../model'

/**
 * F-OL-01 (Order LINES lane, plan v2 §1; 10-design-tab §11, §15; 18-lead-settles F5, F27, F31) — the Lines tab's draft, pure: the
 * person's OWN changes only, never a copy of the order. Always there (empty), so there is no "start editing": a typed cell, a price,
 * a note, a new colour or style, a removed line wait in it for the save bar. Each step can be taken back ("Undo last edit": a stack of
 * draft steps; no redo). After another person's save the draft is rebased: my changed cells stay, the rest is the fresh order, and the
 * lines that moved are listed; a cell both of us changed asks Keep mine / Take theirs. The save sends only what I changed: a line I
 * did not touch goes as `{ id }` (unchanged), so another person's change is never put back (fixes L2 §6). No fetching, no React.
 */

const phrase = (key: string, params?: Record<string, string | number>): Phrase => (params ? { key, params } : { key })

// ---- the draft ----------------------------------------------------------------------------------------------------------------

/** My changes of one saved line: only what differs from the order as it is (a cell typed back to its value leaves the draft). */
export interface LineEdit {
  /** size → pieces, only the cells I changed. */
  readonly sizes?: Readonly<Record<string, number>>
  /** The unit price as typed (price readers only). */
  readonly price?: string
  /** "On the order — the customer sees it". */
  readonly description?: string
  /** "For the floor — no prices". */
  readonly note?: string
  /** Removed (struck in the table, "Put back" undoes it). */
  readonly removed?: true
}

/** A new colour row (from Add a style or + Add a colour): its sizes typed in the table. */
export interface NewLine {
  /** `new:<styleId>:<colourwayId>`. */
  readonly key: string
  readonly styleId: string
  readonly colourwayId: string
  /** What the row is called ("BLK · Black"), the style's code and name (the order does not hold them yet). */
  readonly colour: string
  readonly style: { readonly code: string; readonly name: string }
  readonly sizes: Readonly<Record<string, number>>
  /** Empty: the customer's list price (the server prices it). */
  readonly price: string
  readonly description: string
  readonly note: string
  readonly options?: readonly PickBody[]
}

export interface LinesDraft {
  /** By saved line id. */
  readonly lines: Readonly<Record<string, LineEdit>>
  readonly added: readonly NewLine[]
  /** "+ Size": the sizes a style's card shows beyond its lines' own (by style id). */
  readonly sizes: Readonly<Record<string, readonly string[]>>
}

export const EMPTY_DRAFT: LinesDraft = Object.freeze({ lines: Object.freeze({}), added: Object.freeze([]) as readonly NewLine[], sizes: Object.freeze({}) }) as LinesDraft

/** The draft and its undo stack (each entry: the draft before one step). Typing in one box is ONE step (`last` = that box). */
export interface DraftHistory {
  readonly draft: LinesDraft
  readonly undo: readonly LinesDraft[]
  readonly last: string | null
}

export const EMPTY_HISTORY: DraftHistory = Object.freeze({ draft: EMPTY_DRAFT, undo: Object.freeze([]) as readonly LinesDraft[], last: null }) as DraftHistory

/** The undo stack keeps this many steps (an afternoon of typing). */
export const UNDO_LIMIT = 200

export const newLineKey = (styleId: string, colourwayId: string): string => `new:${styleId}:${colourwayId}`

/** Whether a line's cells and price are typed in the table: a size-grid line still open (a made-to-measure unit and a closed line: notes only). */
export const typeable = (line: Pick<OrderLine, 'kind' | 'closedShort'>): boolean => line.kind === 'SIZE_GRID' && !line.closedShort

/** The goods lines of the order (a charge is its own block, never a row). */
export const goodsLines = (order: Pick<Order, 'lines'>): Order['lines'] => [...order.lines].filter((line) => line.kind !== 'FEE').sort((a, b) => a.seq - b.seq)

/** The order's own pieces of a line by size (a made-to-measure unit has none). */
export function baseSizesOf(line: Pick<OrderLine, 'sizes'>): Record<string, number> {
  return Object.fromEntries(line.sizes.flatMap((size) => (size.size === null ? [] : [[size.size, size.quantity]])))
}

const samePrice = (typed: string, stored: string | undefined): boolean => {
  const parsed = parsePrice(typed)
  if (parsed === null) return typed.trim() === '' || false
  return stored !== undefined && Number(parsed) === Number(stored)
}

/** An edit without what equals the order (a cell typed back to its value, a price as it was): nothing left → null. */
export function normaliseEdit(edit: LineEdit, line: OrderLine): LineEdit | null {
  const base = baseSizesOf(line)
  const sizes = Object.fromEntries(Object.entries(edit.sizes ?? {}).filter(([size, pieces]) => pieces !== (base[size] ?? 0)))
  const out: { -readonly [K in keyof LineEdit]: LineEdit[K] } = {}
  if (Object.keys(sizes).length > 0) out.sizes = sizes
  if (edit.price !== undefined && !(edit.price.trim() === '' ? true : samePrice(edit.price, line.unitPrice))) out.price = edit.price
  if (edit.description !== undefined && edit.description.trim() !== (line.description ?? '').trim()) out.description = edit.description
  if (edit.note !== undefined && edit.note.trim() !== (line.note ?? '').trim()) out.note = edit.note
  if (edit.removed) out.removed = true
  return Object.keys(out).length > 0 ? out : null
}

/** One step: the draft before it goes on the undo stack, unless it is the same box as the last step (one step per box). */
function step(history: DraftHistory, field: string | null, next: LinesDraft): DraftHistory {
  if (next === history.draft) return history
  const coalesce = field !== null && history.last === field && history.undo.length > 0
  const undo = coalesce ? history.undo : [...history.undo, history.draft].slice(-UNDO_LIMIT)
  return { draft: next, undo, last: field }
}

function withEdit(draft: LinesDraft, order: Pick<Order, 'lines'>, lineId: string, change: (edit: LineEdit) => LineEdit): LinesDraft {
  const line = order.lines.find((entry) => entry.id === lineId)
  if (!line) return draft
  const next = normaliseEdit(change(draft.lines[lineId] ?? {}), line)
  const lines = { ...draft.lines }
  if (next) lines[lineId] = next
  else delete lines[lineId]
  return { ...draft, lines }
}

/** A cell of a saved line typed (pieces ≥ 0; a cell typed back to the order's value leaves the draft). */
export function setCell(history: DraftHistory, order: Pick<Order, 'lines'>, lineId: string, size: string, pieces: number): DraftHistory {
  const value = Math.max(0, Math.floor(Number.isFinite(pieces) ? pieces : 0))
  return step(history, `cell:${lineId}:${size}`, withEdit(history.draft, order, lineId, (edit) => ({ ...edit, sizes: { ...(edit.sizes ?? {}), [size]: value } })))
}

/** The unit price of a saved line typed (as text: a price that is not one holds the bar, said at its cell). */
export function setPrice(history: DraftHistory, order: Pick<Order, 'lines'>, lineId: string, text: string): DraftHistory {
  return step(history, `price:${lineId}`, withEdit(history.draft, order, lineId, (edit) => ({ ...edit, price: text })))
}

export type NoteField = 'description' | 'note'

/** A line's notes typed in its fold. */
export function setText(history: DraftHistory, order: Pick<Order, 'lines'>, lineId: string, field: NoteField, text: string): DraftHistory {
  return step(history, `${field}:${lineId}`, withEdit(history.draft, order, lineId, (edit) => ({ ...edit, [field]: text })))
}

/** Remove line (into the draft: struck, "Put back"); a new row is simply taken out. */
export function removeLine(history: DraftHistory, order: Pick<Order, 'lines'>, key: string): DraftHistory {
  if (history.draft.added.some((line) => line.key === key)) return step(history, null, { ...history.draft, added: history.draft.added.filter((line) => line.key !== key) })
  return step(history, null, withEdit(history.draft, order, key, (edit) => ({ ...edit, removed: true })))
}

/** Put back: the removed line is kept again (its other changes stay). */
export function putBack(history: DraftHistory, order: Pick<Order, 'lines'>, lineId: string): DraftHistory {
  return step(history, null, withEdit(history.draft, order, lineId, (edit) => without(edit, 'removed')))
}

/** An edit without one of its fields. */
function without(edit: LineEdit, field: keyof LineEdit): LineEdit {
  const out: { -readonly [K in keyof LineEdit]: LineEdit[K] } = { ...edit }
  delete out[field]
  return out
}

/**
 * New rows (Add a style, + Add a colour): a colour already on the order or in the draft is never added twice. `sizes`: the size columns
 * the new rows' style shows from now on (a new style has none of its own yet) — in the same step, so one Undo takes it all back.
 */
export function addLines(history: DraftHistory, order: Pick<Order, 'lines'>, added: readonly NewLine[], sizes: Readonly<Record<string, readonly string[]>> = {}): DraftHistory {
  const have = new Set([...order.lines.map((line) => `${line.styleId}:${line.colourwayId}`), ...history.draft.added.map((line) => `${line.styleId}:${line.colourwayId}`)])
  const fresh = added.filter((line) => !have.has(`${line.styleId}:${line.colourwayId}`))
  if (fresh.length === 0) return history
  const columns = { ...history.draft.sizes }
  for (const [styleId, list] of Object.entries(sizes)) columns[styleId] = [...new Set([...(columns[styleId] ?? []), ...list])]
  return step(history, null, { ...history.draft, added: [...history.draft.added, ...fresh], sizes: columns })
}

/** A cell, the price or a note of a new row. */
export function setNewLine(history: DraftHistory, key: string, change: { readonly size?: string; readonly pieces?: number; readonly price?: string; readonly field?: NoteField; readonly text?: string }): DraftHistory {
  const row = history.draft.added.find((line) => line.key === key)
  if (!row) return history
  let next: NewLine = row
  let field = `new:${key}`
  if (change.size !== undefined) {
    const value = Math.max(0, Math.floor(Number.isFinite(change.pieces ?? 0) ? (change.pieces ?? 0) : 0))
    const sizes = { ...row.sizes }
    if (value > 0) sizes[change.size] = value
    else delete sizes[change.size]
    next = { ...row, sizes }
    field = `new:${key}:${change.size}`
  } else if (change.price !== undefined) {
    next = { ...row, price: change.price }
    field = `new:${key}:price`
  } else if (change.field) {
    next = { ...row, [change.field]: change.text ?? '' }
    field = `new:${key}:${change.field}`
  }
  return step(history, field, { ...history.draft, added: history.draft.added.map((line) => (line.key === key ? next : line)) })
}

/** "+ Size": a size column added to a style's card (an empty column until a cell is typed). */
export function addSize(history: DraftHistory, styleId: string, size: string): DraftHistory {
  const known = history.draft.sizes[styleId] ?? []
  if (known.includes(size)) return history
  return step(history, null, { ...history.draft, sizes: { ...history.draft.sizes, [styleId]: [...known, size] } })
}

/** Undo last edit: the draft as it was before the last step (nothing to undo: as it is). */
export function undoLast(history: DraftHistory): DraftHistory {
  const previous = history.undo[history.undo.length - 1]
  if (!previous) return history
  return { draft: previous, undo: history.undo.slice(0, -1), last: null }
}

// ---- what the draft holds ------------------------------------------------------------------------------------------------

/** A cell as the table shows it: what I typed, else the order's. */
export const cellOf = (draft: LinesDraft, line: Pick<OrderLine, 'id' | 'sizes'>, size: string): number => draft.lines[line.id]?.sizes?.[size] ?? baseSizesOf(line)[size] ?? 0

/** A line's pieces with my cells (a removed line: its pieces as saved). */
export function piecesOfLine(draft: LinesDraft, line: Pick<OrderLine, 'id' | 'sizes' | 'quantity' | 'kind'>): number {
  if (line.kind !== 'SIZE_GRID') return line.quantity
  const edit = draft.lines[line.id]
  if (!edit?.sizes) return line.quantity
  const sizes = { ...baseSizesOf(line), ...edit.sizes }
  return Object.values(sizes).reduce((sum, pieces) => sum + pieces, 0)
}

export const piecesOfNew = (line: Pick<NewLine, 'sizes'>): number => Object.values(line.sizes).reduce((sum, pieces) => sum + (pieces > 0 ? pieces : 0), 0)

export const isEmptyDraft = (draft: LinesDraft): boolean => Object.keys(draft.lines).length === 0 && draft.added.length === 0

/** What one saved line's edit changes. */
export interface LineChange {
  readonly sizes: boolean
  readonly price: boolean
  readonly text: boolean
  readonly removed: boolean
}

export function lineChangeOf(draft: LinesDraft, lineId: string): LineChange | null {
  const edit = draft.lines[lineId]
  if (!edit) return null
  return { sizes: !!edit.sizes && Object.keys(edit.sizes).length > 0, price: edit.price !== undefined, text: edit.description !== undefined || edit.note !== undefined, removed: !!edit.removed }
}

/** The bar's count: one per line that changes (sizes, price, notes), one per removed line, one per new row — the entries Review lists. */
export const changeCountOf = (draft: LinesDraft): number => Object.keys(draft.lines).length + draft.added.length

/** A typed price that is not one ("4,5,0"). */
export const badPriceText = (text: string | undefined): boolean => text !== undefined && text.trim() !== '' && parsePrice(text) === null

// ---- what the save sends -------------------------------------------------------------------------------------------------

const sizeList = (sizes: Readonly<Record<string, number>>) =>
  Object.entries(sizes)
    .filter(([, pieces]) => pieces > 0)
    .map(([size, quantity]) => ({ size, quantity }))

const textOrNull = (text: string): string | null => text.trim() || null

/**
 * The amendment's lines: every goods line the order keeps — one I did not touch as `{ id }` (the server keeps it as it is NOW: another
 * person's change is never put back), one I changed with only what I changed (its whole size grid when I typed a cell: the order's
 * cells as they are now plus mine), a removed one left out, a new row with its pieces. A charge line is never sent (it no longer blocks
 * a change, B-OL-012) — the server keeps it.
 */
export function bodyLinesOf(draft: LinesDraft, order: Pick<Order, 'lines'>): AmendLineInput[] {
  const out: AmendLineInput[] = []
  for (const line of goodsLines(order)) {
    const edit = draft.lines[line.id]
    if (edit?.removed) continue
    if (!edit) {
      out.push({ id: line.id })
      continue
    }
    const sizes = edit.sizes && typeable(line) ? sizeList({ ...baseSizesOf(line), ...edit.sizes }) : null
    // Every size typed to 0: the line is left out (removed), as the old editor did — never a line of no pieces.
    if (sizes && sizes.length === 0) continue
    const price = edit.price !== undefined ? parsePrice(edit.price) : null
    out.push({
      id: line.id,
      ...(sizes ? { sizes } : {}),
      ...(price !== null && typeable(line) ? { unitPrice: price } : {}),
      ...(edit.description !== undefined ? { description: textOrNull(edit.description) } : {}),
      ...(edit.note !== undefined ? { note: textOrNull(edit.note) } : {}),
    })
  }
  for (const line of draft.added) {
    if (piecesOfNew(line) === 0) continue
    const price = parsePrice(line.price)
    out.push({
      styleId: line.styleId,
      colourwayId: line.colourwayId,
      sizes: sizeList(line.sizes),
      ...(price !== null ? { unitPrice: price } : {}),
      ...(line.options?.length ? { options: [...line.options] } : {}),
      ...(textOrNull(line.description) ? { description: textOrNull(line.description) } : {}),
      ...(textOrNull(line.note) ? { note: textOrNull(line.note) } : {}),
    })
  }
  return out
}

/** What a preview is about: the lines it was asked with, on the order's version (an answer about another one is stale). */
export const draftKeyOf = (draft: LinesDraft, order: Pick<Order, 'lines' | 'version'>, askCustomer?: boolean | null): string => JSON.stringify([order.version, bodyLinesOf(draft, order), askCustomer ?? null])

// ---- why "Review and save…" waits ------------------------------------------------------------------------------------------

/** One cell (or a line's price, or a new row) that holds the bar, named for its place. */
export type DraftHold =
  | { readonly kind: 'clash'; readonly count: number }
  | { readonly kind: 'shipped'; readonly lineId: string; readonly size: string; readonly count: number }
  | { readonly kind: 'price'; readonly key: string }
  | { readonly kind: 'needsPrice'; readonly key: string }
  | { readonly kind: 'noPieces'; readonly key: string }
  | { readonly kind: 'lockedForGood'; readonly lineId: string; readonly size: string }
  | { readonly kind: 'empty' }

/**
 * The bar's holds, in order (10 §11): cells changed by both people not chosen yet; a size under what already shipped; a price that is
 * not one; a new row a price reader leaves without a price and no list price prices it (said only when the search said so); a new row
 * with no pieces; a size locked for good typed anyway; no goods line left.
 */
export function draftHoldsOf(draft: LinesDraft, order: Pick<Order, 'lines'>, input: { readonly floors?: CellFloors; readonly clashes?: number; readonly lockedForGood?: ReadonlyArray<{ readonly lineId: string; readonly size: string }>; readonly unlisted?: ReadonlySet<string> } = {}): DraftHold[] {
  const out: DraftHold[] = []
  if ((input.clashes ?? 0) > 0) out.push({ kind: 'clash', count: input.clashes! })
  for (const [lineId, edit] of Object.entries(draft.lines)) {
    if (edit.removed) continue
    for (const [size, pieces] of Object.entries(edit.sizes ?? {})) {
      const shipped = input.floors?.[lineId]?.[size]?.shipped ?? 0
      if (pieces < shipped) out.push({ kind: 'shipped', lineId, size, count: shipped })
      if ((input.lockedForGood ?? []).some((cell) => cell.lineId === lineId && cell.size === size)) out.push({ kind: 'lockedForGood', lineId, size })
    }
    if (badPriceText(edit.price)) out.push({ kind: 'price', key: lineId })
  }
  for (const line of draft.added) {
    if (badPriceText(line.price)) out.push({ kind: 'price', key: line.key })
    else if (line.price.trim() === '' && input.unlisted?.has(line.colourwayId)) out.push({ kind: 'needsPrice', key: line.key })
    if (piecesOfNew(line) === 0) out.push({ kind: 'noPieces', key: line.key })
  }
  const kept = goodsLines(order).filter((line) => !draft.lines[line.id]?.removed && (line.kind !== 'SIZE_GRID' || piecesOfLine(draft, line) > 0 || !!line.closedShort)).length + draft.added.filter((line) => piecesOfNew(line) > 0).length
  if (!isEmptyDraft(draft) && kept === 0) out.push({ kind: 'empty' })
  return out
}

/** A hold in words (the bar's held reason, the cell's own line): `name(key)` says the line ("Black", "line 2"). */
export function holdPhrase(hold: DraftHold, name: (key: string) => string): Phrase {
  switch (hold.kind) {
    case 'clash':
      return phrase('save.held.clash', { count: hold.count })
    case 'shipped':
      return phrase('save.held.shipped', { colour: name(hold.lineId), size: hold.size, count: hold.count })
    case 'price':
      return phrase('save.held.price', { colour: name(hold.key) })
    case 'needsPrice':
      return phrase('save.held.needsPrice', { colour: name(hold.key) })
    case 'noPieces':
      return phrase('save.held.noPieces', { colour: name(hold.key) })
    case 'lockedForGood':
      return phrase('save.held.lockedForGood', { colour: name(hold.lineId), size: hold.size })
    default:
      return phrase('save.held.empty')
  }
}

// ---- two people: the draft rebased on the fresh order ---------------------------------------------------------------------

export type ClashField = { readonly kind: 'size'; readonly size: string } | { readonly kind: 'price' } | { readonly kind: 'description' } | { readonly kind: 'note' }

/** A cell both of us changed: mine stays in the draft until chosen; theirs is the fresh order's value. */
export interface Clash {
  readonly lineId: string
  readonly field: ClashField
  readonly mine: string
  readonly theirs: string
}

export const clashKey = (clash: Pick<Clash, 'lineId' | 'field'>): string => `${clash.lineId}:${clash.field.kind}${clash.field.kind === 'size' ? `:${clash.field.size}` : ''}`

export interface Rebased {
  readonly draft: LinesDraft
  /** Lines of the fresh order that another person changed (they flash, the banner names them). */
  readonly moved: readonly string[]
  /** Cells both changed (Keep mine / Take theirs inside the cell; the bar waits). */
  readonly clashes: readonly Clash[]
  /** Lines I changed that the other person removed: my changes on them are dropped. */
  readonly gone: readonly string[]
}

const lineFace = (line: OrderLine) => JSON.stringify([baseSizesOf(line), line.unitPrice ?? null, line.description ?? null, line.note ?? null, line.closedShort?.quantity ?? null, line.promiseDate])

/**
 * `rebaseDraft(base, fresh, mine)`: my draft was typed on `base`; `fresh` is the order after another person's save. My changed cells
 * stay; everything else comes from `fresh`. A field we both changed to different values is a clash (mine kept until chosen); one they
 * changed to exactly my value is no change of mine any more; a line they removed drops my changes on it.
 */
export function rebaseDraft(base: Pick<Order, 'lines'>, fresh: Pick<Order, 'lines'>, mine: LinesDraft): Rebased {
  const before = new Map(base.lines.map((line) => [line.id, line]))
  const after = new Map(fresh.lines.map((line) => [line.id, line]))
  const moved = goodsLines(fresh)
    .filter((line) => {
      const old = before.get(line.id)
      return !old || lineFace(old) !== lineFace(line)
    })
    .map((line) => line.id)
  const gone: string[] = []
  const clashes: Clash[] = []
  const lines: Record<string, LineEdit> = {}
  for (const [lineId, edit] of Object.entries(mine.lines)) {
    const now = after.get(lineId)
    const old = before.get(lineId)
    if (!now) {
      gone.push(lineId)
      continue
    }
    if (old) {
      const oldSizes = baseSizesOf(old)
      const newSizes = baseSizesOf(now)
      for (const [size, pieces] of Object.entries(edit.sizes ?? {})) {
        if ((oldSizes[size] ?? 0) !== (newSizes[size] ?? 0) && (newSizes[size] ?? 0) !== pieces) clashes.push({ lineId, field: { kind: 'size', size }, mine: String(pieces), theirs: String(newSizes[size] ?? 0) })
      }
      if (edit.price !== undefined && (old.unitPrice ?? null) !== (now.unitPrice ?? null) && !samePrice(edit.price, now.unitPrice)) clashes.push({ lineId, field: { kind: 'price' }, mine: edit.price, theirs: now.unitPrice ?? '' })
      for (const field of ['description', 'note'] as const) {
        const typed = edit[field]
        if (typed !== undefined && (old[field] ?? '') !== (now[field] ?? '') && typed.trim() !== (now[field] ?? '').trim()) clashes.push({ lineId, field: { kind: field }, mine: typed, theirs: now[field] ?? '' })
      }
    }
    const next = normaliseEdit(edit, now)
    if (next) lines[lineId] = next
  }
  const added = mine.added.filter((line) => !fresh.lines.some((entry) => entry.styleId === line.styleId && entry.colourwayId === line.colourwayId))
  return { draft: { ...mine, lines, added }, moved, clashes, gone }
}

/** Take theirs: my change of that cell leaves the draft (the fresh order's value shows). */
export function takeTheirs(history: DraftHistory, order: Pick<Order, 'lines'>, clash: Pick<Clash, 'lineId' | 'field'>): DraftHistory {
  return step(
    history,
    null,
    withEdit(history.draft, order, clash.lineId, (edit) => {
      if (clash.field.kind === 'size') {
        const sizes = { ...(edit.sizes ?? {}) }
        delete sizes[clash.field.size]
        return { ...edit, sizes }
      }
      return without(edit, clash.field.kind)
    }),
  )
}

/** The clashes still to choose after one is chosen (Keep mine or Take theirs). */
export const withoutClash = (clashes: readonly Clash[], chosen: Pick<Clash, 'lineId' | 'field'>): Clash[] => clashes.filter((entry) => clashKey(entry) !== clashKey(chosen))

// ---- Review and save: what changes, line by line ----------------------------------------------------------------------------

export type ReviewEntry =
  | { readonly kind: 'changed'; readonly key: string; readonly seq: number; readonly sizes: readonly { readonly size: string; readonly before: number; readonly after: number }[]; readonly piecesBefore: number; readonly piecesAfter: number; readonly price: { readonly before: string | null; readonly after: string } | null; readonly notes: boolean }
  | { readonly kind: 'added'; readonly key: string; readonly pieces: number }
  | { readonly kind: 'removed'; readonly key: string; readonly seq: number; readonly pieces: number; readonly closesShort: boolean }

/**
 * One entry per line that changes, in the table's order: its sizes before → after, its price (price readers only: `seesPrices`), its
 * notes; a new row with its pieces; a removed line (closed with fewer pieces instead when work orders make it, cut or shipped).
 */
export function reviewEntriesOf(draft: LinesDraft, order: Pick<Order, 'lines'>, input: { readonly seesPrices: boolean; readonly floors?: CellFloors }): ReviewEntry[] {
  const out: ReviewEntry[] = []
  for (const line of goodsLines(order)) {
    const edit = draft.lines[line.id]
    if (!edit) continue
    if (edit.removed) {
      const floors = input.floors?.[line.id] ?? {}
      const made = line.progress.inWorkOrders > 0 || line.progress.shipped > 0 || Object.values(floors).some((floor) => floor.cut > 0 || floor.shipped > 0)
      out.push({ kind: 'removed', key: line.id, seq: line.seq, pieces: line.quantity, closesShort: made })
      continue
    }
    const base = baseSizesOf(line)
    const sizes = Object.entries(edit.sizes ?? {}).map(([size, after]) => ({ size, before: base[size] ?? 0, after }))
    if (sizes.length > 0 && typeable(line) && piecesOfLine(draft, line) === 0) {
      out.push({ kind: 'removed', key: line.id, seq: line.seq, pieces: line.quantity, closesShort: line.progress.inWorkOrders > 0 })
      continue
    }
    const price = input.seesPrices && edit.price !== undefined ? { before: line.unitPrice ?? null, after: parsePrice(edit.price) ?? edit.price } : null
    out.push({ kind: 'changed', key: line.id, seq: line.seq, sizes, piecesBefore: line.quantity, piecesAfter: piecesOfLine(draft, line), price, notes: edit.description !== undefined || edit.note !== undefined })
  }
  for (const line of draft.added) out.push({ kind: 'added', key: line.key, pieces: piecesOfNew(line) })
  return out
}

/** The order's pieces before → after the draft (Sales reads pieces only, never the money). */
export function piecesBeforeAfter(draft: LinesDraft, order: Pick<Order, 'lines'>): { readonly before: number; readonly after: number } {
  const goods = goodsLines(order)
  const before = goods.reduce((sum, line) => sum + line.quantity - (line.closedShort?.quantity ?? 0), 0)
  const after = goods.reduce((sum, line) => sum + (draft.lines[line.id]?.removed ? 0 : piecesOfLine(draft, line) - (line.closedShort?.quantity ?? 0)), 0) + draft.added.reduce((sum, line) => sum + piecesOfNew(line), 0)
  return { before, after }
}

// ---- the Review window's choices ---------------------------------------------------------------------------------------------

/** "Why (optional)" quick picks (F22: one list for change, close, reopen). */
export const WHY_PICKS = ['customer', 'mistake', 'production', 'other'] as const
export type WhyPick = (typeof WHY_PICKS)[number]

/**
 * The reason the save sends: the pick's words and the typed words ("Customer asked: two more in 52"); nothing picked or typed → none
 * (the server writes its automatic words, B-OL-004). `say` gives a pick's words in the order's language.
 */
export function reasonOf(pick: WhyPick | null, words: string, say: (pick: WhyPick) => string): string | undefined {
  const typed = words.trim()
  const lead = pick && pick !== 'other' ? say(pick) : null
  const text = lead && typed ? `${lead}: ${typed}` : (lead ?? typed)
  return text ? text.slice(0, 1000) : undefined
}

/**
 * The tick "Ask {customer} to accept the new order" before the person touches it (F10; ol-s1's preview): a price reader — on only
 * when what the customer pays goes up (`totalUp`, the price grain only); Sales — on whenever the amount changes (`amountChanges`;
 * never told which way it moved: the money wall). `diff.reacceptanceNeeded` only says the net changed: never the default.
 */
export function askDefaultOf(preview: { readonly amountChanges?: boolean; readonly totalUp?: boolean } | null, seesPrices: boolean): boolean {
  if (!preview) return false
  return seesPrices ? preview.totalUp === true : preview.amountChanges === true
}

// ---- F-OL-03: the notice after a save ("Saved · WO-0311 changed · WO-0312 waits for production — decide on this page") ----------

/**
 * The words after Save changes: the work orders that followed in the same command and those that wait (B-OP-012's answer), and
 * whether the customer is asked to accept the new order (the tick). Never an amendment number, never an amount.
 */
export function savedNotice(followed: Followed, asked: boolean): Phrase {
  const numbers = (entries: readonly { readonly number: string | null }[]) => entries.map((entry) => entry.number ?? 'WO-…').join(', ')
  const changed = numbers(followed.applied)
  const waits = numbers(followed.waiting)
  const which = changed && waits ? 'both' : changed ? 'changed' : waits ? 'waits' : 'plain'
  return phrase(`save.done.${which}${asked ? 'Asked' : ''}`, { ...(changed ? { changed } : {}), ...(waits ? { waits } : {}) })
}

/** A change fee as typed (price readers, a priced change): empty, or 0 and more with at most 2 decimals (0 allowed: B-OL-016). */
export const feeProblem = (fee: string): boolean => fee.trim() !== '' && !/^\d{1,12}([.,]\d{1,2})?$/.test(fee.trim())
// ---- end F-OL-03
