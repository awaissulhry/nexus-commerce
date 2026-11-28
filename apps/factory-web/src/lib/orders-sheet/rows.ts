import type { OrdersSheetLine, OrdersSheetOrder, SheetAsk, SheetColumnId, SheetCommit, SheetCommitAnswer, SheetKind, SheetOwnValue } from './model'

/**
 * owb-of3 — the ONE orders sheet's rules, pure (no React, no fetch): which rows it draws, which cell a person may type in, what a
 * typed value is, the asked values beside the official ones, the totals, the groups of the coloured strip and the doors a row
 * opens. The part (`view/OrdersSheet.tsx`) draws them; each door (the office, S1's portal) maps its own read into
 * `OrdersSheetOrder` and answers the typing (L2).
 */

/** The part's own words (`messages/<locale>/orders-sheet.json`, under `part.*`). */
export const SHEET_NS = 'orders-sheet'

export const NEW_ROW_KEY = 'new'
export const TOTALS_ROW_KEY = 'totals'

/** N = the "New order" row · P = an order · C = one of its lines · T = the totals row. */
export type SheetRowKind = 'N' | 'P' | 'C' | 'T'

export interface SheetRow {
  readonly key: string
  readonly kind: SheetRowKind
  readonly order: OrdersSheetOrder | null
  readonly line: OrdersSheetLine | null
  /** C: the line's place in its order (0-based); else -1. */
  readonly index: number
}

export const TOTALS_ROW: SheetRow = Object.freeze({ key: TOTALS_ROW_KEY, kind: 'T', order: null, line: null, index: -1 })

/**
 * The rows: "New order" first (when the door offers a new order), then each order (P) and, unless the person shut it, its lines (C)
 * right under it. The orders keep the door's order (the read's: newest change first).
 */
export function sheetRowsOf(orders: readonly OrdersSheetOrder[], shut: ReadonlySet<string>, withNew: boolean): SheetRow[] {
  const rows: SheetRow[] = withNew ? [{ key: NEW_ROW_KEY, kind: 'N', order: null, line: null, index: -1 }] : []
  for (const order of orders) {
    rows.push({ key: order.key, kind: 'P', order, line: null, index: -1 })
    if (shut.has(order.key)) continue
    order.lines.forEach((line, index) => rows.push({ key: line.key, kind: 'C', order, line, index }))
  }
  return rows
}

// ---- typing (L2) ------------------------------------------------------------------------------------------------------------

export type TypingMode = NonNullable<OrdersSheetOrder['may']['editLines']>

/**
 * What each way of typing reaches: DRAFT saves in place (the subject and the wanted day of the order; a line's product words,
 * material, sizes and pieces) · ASK (the customer after Confirm) asks a change of a line · AMEND (the office after Confirm) stages ONE
 * change of a line's sizes and opens the door's Review and save window — never a silent write. Every other cell reads only.
 */
export const TYPEABLE: Readonly<Record<TypingMode, { readonly P: readonly SheetColumnId[]; readonly C: readonly SheetColumnId[] }>> = Object.freeze({
  DRAFT: { P: ['what', 'wanted'], C: ['what', 'material', 'sizes', 'pieces'] },
  ASK: { P: [], C: ['what', 'material', 'sizes', 'pieces'] },
  AMEND: { P: [], C: ['sizes'] },
})

/** The "New order" row: the office types a subject (it asks the customer first); the customer starts a draft from any of these cells. */
export const NEW_ROW_TYPEABLE: Readonly<Record<SheetKind, readonly SheetColumnId[]>> = Object.freeze({
  office: ['what'],
  portal: ['what', 'wanted', 'material', 'sizes', 'pieces'],
})

/** Whether a person may type in this cell. A cell that may not be typed in takes nothing. */
export function mayType(row: SheetRow, column: SheetColumnId, kind: SheetKind, withNew: boolean): boolean {
  if (row.kind === 'N') return withNew && NEW_ROW_TYPEABLE[kind].includes(column)
  if ((row.kind !== 'P' && row.kind !== 'C') || !row.order) return false
  const mode = row.order.may.editLines
  if (!mode || row.order.life === 'WITHDRAWN') return false
  return TYPEABLE[mode][row.kind].includes(column)
}

/** Why a cell that a draft would take reads only now: a Sent order waits for Confirm (office), or the order is past typing. */
export type HeldWhy = 'confirmFirst' | 'readOnly'

export function heldWhyOf(row: SheetRow, column: SheetColumnId, kind: SheetKind): HeldWhy | null {
  if ((row.kind !== 'P' && row.kind !== 'C') || !row.order) return null
  if (mayType(row, column, kind, false)) return null
  if (!TYPEABLE.DRAFT[row.kind].includes(column)) return null
  return kind === 'office' && row.order.life === 'SENT' ? 'confirmFirst' : 'readOnly'
}

/** The official value a cell's editor starts with. */
export function cellValueOf(row: SheetRow, column: SheetColumnId): string {
  const { order, line } = row
  if (!order) return ''
  if (row.kind === 'P') {
    if (column === 'what') return order.subject ?? ''
    if (column === 'wanted') return order.wantedFor ?? ''
    return ''
  }
  if (!line) return ''
  if (column === 'what') return line.text ?? (line.product ? `${line.product.code} ${line.product.name}`.trim() : '')
  if (column === 'material') return line.material ?? ''
  if (column === 'sizes') return line.sizes ?? ''
  if (column === 'pieces') return String(line.pieces)
  return ''
}

/** A number cell takes a sum: `=500+20`, `3*150`, brackets. Digits, + − × ÷ and brackets only; anything else is not a number. */
export function sumOf(text: string): number | null {
  const source = text.trim().replace(/^=/, '').replace(/,/g, '.').replace(/×/g, '*').replace(/÷/g, '/')
  if (source === '' || !/^[\d.+\-*/()\s]+$/.test(source)) return null
  let at = 0
  const peek = (): string => {
    while (source[at] === ' ') at++
    return source[at] ?? ''
  }
  const number = (): number | null => {
    const char = peek()
    if (char === '(') {
      at++
      const inside = sum()
      if (inside === null || peek() !== ')') return null
      at++
      return inside
    }
    if (char === '-') {
      at++
      const value = number()
      return value === null ? null : -value
    }
    const found = /^\d+(\.\d+)?/.exec(source.slice(at))
    if (!found) return null
    at += found[0].length
    return Number(found[0])
  }
  const product = (): number | null => {
    let value = number()
    while (value !== null && (peek() === '*' || peek() === '/')) {
      const op = source[at++]
      const next = number()
      if (next === null || (op === '/' && next === 0)) return null
      value = op === '*' ? value * next : value / next
    }
    return value
  }
  function sum(): number | null {
    let value = product()
    while (value !== null && (peek() === '+' || peek() === '-')) {
      const op = source[at++]
      const next = product()
      if (next === null) return null
      value = op === '+' ? value + next : value - next
    }
    return value
  }
  const value = sum()
  return value !== null && peek() === '' && Number.isFinite(value) ? value : null
}

/** Pieces: a whole number of 1 or more (a sum may make it). */
export function piecesOf(text: string): number | null {
  const value = sumOf(text)
  return value !== null && Number.isInteger(value) && value >= 1 ? value : null
}

/** A day as typed → `YYYY-MM-DD` (also `D/M/YYYY`, `D.M.YYYY`, `D-M-YYYY`); '' = no day; null = not a day. */
export function dayOf(text: string): string | null {
  const value = text.trim()
  if (value === '') return ''
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  const local = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(value)
  const [year, month, day] = iso ? [Number(iso[1]), Number(iso[2]), Number(iso[3])] : local ? [Number(local[3]), Number(local[2]), Number(local[1])] : [0, 0, 0]
  if (!year) return null
  const date = new Date(Date.UTC(year, month - 1, day))
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** A typed value as the door receives it, or why the part refuses it before asking anybody (`part.refused.<why>`). */
export function typedValueOf(column: SheetColumnId, raw: string): { readonly value: string } | { readonly refused: 'pieces' | 'day' } {
  if (column === 'pieces') {
    const pieces = piecesOf(raw)
    return pieces === null ? { refused: 'pieces' } : { value: String(pieces) }
  }
  if (column === 'wanted') {
    const day = dayOf(raw)
    return day === null ? { refused: 'day' } : { value: day }
  }
  return { value: raw.trim() }
}

/**
 * What a typed cell becomes: nothing (a cell a person may not type in takes nothing; the same value again), a refusal in the part's
 * words before anybody is asked, a new draft from the "New order" row (its seed), or ONE commit the door answers.
 */
export type CommitPlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'refused'; readonly why: 'pieces' | 'day' }
  | { readonly kind: 'new'; readonly seed: { readonly column: SheetColumnId; readonly value: string } }
  | { readonly kind: 'commit'; readonly commit: SheetCommit }

export function commitOf(row: SheetRow, column: SheetColumnId, raw: string, kind: SheetKind, withNew: boolean): CommitPlan {
  if (!mayType(row, column, kind, withNew)) return { kind: 'none' }
  if (row.kind === 'N') {
    const value = raw.trim()
    return value === '' ? { kind: 'none' } : { kind: 'new', seed: { column, value } }
  }
  if (!row.order) return { kind: 'none' }
  const typed = typedValueOf(column, raw)
  if ('refused' in typed) return { kind: 'refused', why: typed.refused }
  if (typed.value === cellValueOf(row, column).trim()) return { kind: 'none' }
  return { kind: 'commit', commit: { orderKey: row.order.key, lineKey: row.kind === 'C' ? row.key : null, column, value: typed.value } }
}

// ---- the customer's asks: amber beside the official value -------------------------------------------------------------------

const ASK_COLUMN: Readonly<Record<SheetAsk['column'], SheetColumnId>> = Object.freeze({ product: 'what', material: 'material', sizes: 'sizes', pieces: 'pieces', cancel: 'what' })

/** The open ask a line holds in this column (the asked value is drawn beside the official one). */
export function askOf(row: SheetRow, column: SheetColumnId): SheetAsk | null {
  if (row.kind !== 'C' || !row.line) return null
  return row.line.asks.find((ask) => ASK_COLUMN[ask.column] === column) ?? null
}

/** Every open ask of an order, line by line. */
export const openAsksOf = (order: Pick<OrdersSheetOrder, 'lines'>): SheetAsk[] => order.lines.flatMap((line) => line.asks)

// ---- totals, details, groups -------------------------------------------------------------------------------------------------

/** The totals row: the selected orders' when some are selected, else every order on screen (the official record only). */
export function totalsOf(orders: readonly OrdersSheetOrder[], selected: ReadonlySet<string>): { readonly orders: number; readonly lines: number; readonly pieces: number; readonly selected: boolean } {
  const picked = orders.filter((order) => selected.has(order.key))
  const base = picked.length > 0 ? picked : orders
  return { orders: base.length, lines: base.reduce((sum, order) => sum + order.lines.length, 0), pieces: base.reduce((sum, order) => sum + order.pieces, 0), selected: picked.length > 0 }
}

/** An own value in words (a Yes / No in the person's words); null: nothing given. */
export function ownWordsOf(own: SheetOwnValue, yesNo: { readonly yes: string; readonly no: string }): string | null {
  if (own.value === null || own.value === '') return null
  if (own.kind === 'YES_NO') return own.value === true || own.value === 'true' ? yesNo.yes : yesNo.no
  return String(own.value)
}

/** The Details cell: the customer's own columns as chips — two, then "+ n" (the rest in the tip). */
export function detailsOf(own: readonly SheetOwnValue[]): { readonly shown: readonly SheetOwnValue[]; readonly more: readonly SheetOwnValue[] } {
  const given = own.filter((value) => value.value !== null && value.value !== '')
  return { shown: given.slice(0, 2), more: given.slice(2) }
}

/** An order's own values over its lines (each column and value once). */
export function orderOwnOf(order: Pick<OrdersSheetOrder, 'lines'>): SheetOwnValue[] {
  const seen = new Set<string>()
  const out: SheetOwnValue[] = []
  for (const line of order.lines) {
    for (const own of line.own) {
      const key = `${own.columnId}:${String(own.value)}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(own)
    }
  }
  return out
}

/** An order's materials in one line ("Cowhide · Kangaroo"); a line with none counts as "not decided" (`null` in the list). */
export function materialsOf(order: Pick<OrdersSheetOrder, 'lines'>): Array<string | null> {
  return [...new Set(order.lines.map((line) => line.material))]
}

export type SheetGroup = 'order' | 'production' | 'news' | 'product' | 'act'

export const COLUMN_GROUP: Readonly<Record<SheetColumnId, SheetGroup>> = Object.freeze({
  what: 'order',
  customer: 'order',
  wanted: 'order',
  promised: 'order',
  where: 'production',
  news: 'news',
  material: 'product',
  sizes: 'product',
  pieces: 'product',
  details: 'product',
  act: 'act',
})

/** The strip's tone of each group (the grid's group tones: slate, blue, orange, pink); the act column wears none. */
export const GROUP_TONE: Readonly<Record<SheetGroup, string | null>> = Object.freeze({ order: 'slate', product: 'blue', production: 'orange', news: 'pink', act: null })

/** The coloured strip: each run of neighbouring columns of one group is one band. */
export function groupsOf(columns: readonly SheetColumnId[]): Array<{ readonly group: SheetGroup; readonly columns: SheetColumnId[] }> {
  const out: Array<{ group: SheetGroup; columns: SheetColumnId[] }> = []
  for (const column of columns) {
    const group = COLUMN_GROUP[column]
    const last = out[out.length - 1]
    if (last && last.group === group) last.columns.push(column)
    else out.push({ group, columns: [column] })
  }
  return out
}

/** Each column's first width (px); a person pulls the edge of its head to change it. */
export const COLUMN_WIDTH: Readonly<Record<SheetColumnId, number>> = Object.freeze({ what: 196, customer: 150, wanted: 108, promised: 108, where: 208, news: 250, material: 184, sizes: 170, pieces: 92, details: 196, act: 124 })

/** The pinned first column (the chevron, P / C, the picture, the number, the department, + a piece, the bin). */
export const IDENTITY_WIDTH: Readonly<Record<SheetKind, number>> = Object.freeze({ office: 312, portal: 276 })

/** Columns whose value is a number (right aligned). */
export const NUMBER_COLUMNS: ReadonlySet<SheetColumnId> = new Set<SheetColumnId>(['pieces'])

// ---- doors -------------------------------------------------------------------------------------------------------------------

/** What a row's own buttons ask the door to do. A chip carries its own door (the door's target). */
export type SheetAct = 'open' | 'confirm' | 'send' | 'withdraw' | 'askCancel' | 'picture' | 'addLine' | 'deleteDraft'

export const targetOf = (act: SheetAct, orderKey: string): string => `${act}:${orderKey}`

/** A target as `act` + the order's key (split at the first colon: a key may hold more). */
export function parseTarget(target: string): { readonly act: string; readonly key: string } {
  const at = target.indexOf(':')
  return at < 0 ? { act: target, key: '' } : { act: target.slice(0, at), key: target.slice(at + 1) }
}

/** The act column's main button: Confirm (office) / Send… (customer) on a row the person may, else Open. */
export function mainActOf(order: OrdersSheetOrder, kind: SheetKind): { readonly act: SheetAct; readonly primary: boolean } {
  if (kind === 'office' && (order.life === 'DRAFT' || order.life === 'SENT') && order.may.confirm) return { act: 'confirm', primary: true }
  if (kind === 'portal' && order.life === 'DRAFT' && order.may.send) return { act: 'send', primary: true }
  return { act: 'open', primary: false }
}

/** The customer's second button: Withdraw a draft or a sent order; ask to cancel after Confirm (once). The office has none. */
export function sideActOf(order: OrdersSheetOrder, kind: SheetKind): SheetAct | null {
  if (kind !== 'portal') return null
  if ((order.life === 'DRAFT' || order.life === 'SENT') && order.may.withdraw) return 'withdraw'
  const cancelAsked = openAsksOf(order).some((ask) => ask.column === 'cancel')
  if ((order.life === 'CONFIRMED' || order.life === 'IN_PRODUCTION' || order.life === 'READY_TO_SHIP') && order.may.askCancel && !cancelAsked) return 'askCancel'
  return null
}

// ---- the office's department of an order (its production stage) ---------------------------------------------------------------

/** Today's production stages (the order read's `where.stage`) and the fixed department each one is in. */
const STAGE_DEPARTMENT: Readonly<Record<string, number>> = Object.freeze({ PREPARING: 1, CUTTING: 2, SEWING: 4, QUALITY: 5, READY: 6 })

/** The fixed department number an order is in now (its stage), or null: not started, done, or a stage this map does not know. */
export function departmentNoOf(order: Pick<OrdersSheetOrder, 'life' | 'where'>): number | null {
  if (order.life !== 'IN_PRODUCTION' || !order.where?.stage) return null
  return STAGE_DEPARTMENT[order.where.stage] ?? null
}

// ---- autosave ------------------------------------------------------------------------------------------------------------------

/** The autosave's state in the toolbar: "Autosave on" · "Saving…" · "Saved" · "Asked" · the refusal's words. */
export type SaveState = { readonly kind: 'idle' } | { readonly kind: 'saving' } | { readonly kind: 'saved' } | { readonly kind: 'asked' } | { readonly kind: 'refused'; readonly words: string }

export function saveStateOf(answer: SheetCommitAnswer): SaveState {
  if (answer.kind === 'SAVED') return { kind: 'saved' }
  if (answer.kind === 'ASKED') return { kind: 'asked' }
  if (answer.kind === 'REFUSED') return { kind: 'refused', words: answer.words }
  return { kind: 'idle' }
}

/** The keys of the sheet (their words are `part.keys.<id>`): in the footer's ONE information icon, nowhere else. */
export const SHEET_KEYS: ReadonlyArray<{ readonly keys: readonly string[]; readonly id: string }> = Object.freeze([
  { keys: ['↑', '↓', '←', '→'], id: 'arrows' },
  { keys: ['↵'], id: 'enter' },
  { keys: ['Tab'], id: 'tab' },
  { keys: ['Esc'], id: 'esc' },
  { keys: ['Space'], id: 'select' },
  { keys: ['⇧', 'click'], id: 'range' },
])

/** The part's phone form below this width (its own room, never the window): cards, never the grid. */
export const PHONE_BELOW_PX = 640
export const isPhoneRoom = (width: number): boolean => width > 0 && width < PHONE_BELOW_PX
