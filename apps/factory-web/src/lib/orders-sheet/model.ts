/**
 * owb-of3 step 1 — the ONE orders sheet part's types (FIXED: S1's portal mounts the same part with kind `portal`; a change = tell
 * lead 88 first). Each door maps its own read into `OrdersSheetOrder` (office: `areas/sales/orders/list/`; portal: S1's folder). The
 * part has no fetch of its own and knows no route: it shows rows, takes typing and answers through the props.
 *
 * Rows: one P row per order (the order itself) and, under it, one C row per line. Words of a state only through the base's
 * `orderLifeOf` + `StateChip` (L9). No price field anywhere (the design: prices are Finance's).
 */
import type { Tone } from '@nexus/ui/primitives'
import type { OrderLife } from '@nexus/factory-domain/sales/order-life'

export type { OrderLife }

/** The design system's grid tones (the one semantic colour-role vocabulary a DS Pill / chip takes). */
export type GridTone = Tone

export type SheetKind = 'office' | 'portal'

export type SheetColumnId = 'what' | 'customer' | 'wanted' | 'promised' | 'where' | 'news' | 'material' | 'sizes' | 'pieces' | 'details' | 'act'

/** One chip of the "Waits · news" cell: a door to a page or a window (`target` = the door's own key; the host resolves it). */
export interface SheetChip {
  tone: GridTone
  icon: string /* lucide id */
  words: string
  door: { kind: 'page' | 'window'; target: string } | null
  hint?: string
}

/** The customer's open ask on a line: drawn amber beside the official value. */
export interface SheetAsk {
  requestId: string
  column: 'product' | 'material' | 'sizes' | 'pieces' | 'cancel'
  from: string
  to: string
}

/** One own-column value of a line (the customer's own columns, shown as chips in Details). */
export interface SheetOwnValue {
  columnId: string
  name: string
  kind: 'TEXT' | 'YES_NO' | 'CHOICE' | 'NUMBER' | 'DATE'
  value: string | number | boolean | null
}

/** A C row: one line of the order. */
export interface OrdersSheetLine {
  key: string
  id: string
  seq: number
  kind: 'CATALOGUE' | 'DESCRIBED' | 'CUSTOM'
  product: { styleId: string; code: string; name: string } | null
  text: string | null
  material: string | null
  sizes: string | null
  sizeFileId: string | null
  pieces: number
  own: SheetOwnValue[]
  asks: SheetAsk[]
}

/** A P row: the order (a SalesOrder, or a Draft / Sent request). */
export interface OrdersSheetOrder {
  key: string
  record: { kind: 'ORDER' | 'REQUEST'; id: string; version: number }
  number: string | null /* the door's own number */
  subject: string | null
  customer: { id: string; code: string; name: string } | null
  life: OrderLife
  wantedFor: string | null
  promised: string | null
  daysLate: number | null
  where: { stage: string | null; health: string | null; held: boolean } | null
  picture: { fileId: string; contentType: string; small: boolean } | null
  chips: SheetChip[]
  pieces: number
  may: {
    open: boolean
    confirm?: boolean
    send?: boolean
    deleteDraft: boolean
    withdraw?: boolean
    askCancel?: boolean
    editLines: 'DRAFT' | 'ASK' | 'AMEND' | null
  }
  lines: OrdersSheetLine[]
}

/** One typed cell, handed to the door (`lineKey` null = the P row's own cell). */
export type SheetCommit = { orderKey: string; lineKey: string | null; column: SheetColumnId; value: string }

/** The door's answer: saved in place, sent as an ask, a review window opened (Confirmed: ONE staged change), or refused in words. */
export type SheetCommitAnswer = { kind: 'SAVED' } | { kind: 'ASKED' } | { kind: 'REVIEW' } | { kind: 'REFUSED'; words: string }

export interface OrdersSheetProps {
  kind: SheetKind
  orders: readonly OrdersSheetOrder[]
  columns: readonly SheetColumnId[]
  filters: { items: ReadonlyArray<{ id: string; words: string; count?: number }>; active: string; onPick(id: string): void }
  tiles?: ReadonlyArray<{ id: string; words: string; count: number; tone: GridTone; onPick(): void }>
  onCommit(commit: SheetCommit): Promise<SheetCommitAnswer>
  onOpen(target: string): void
  onNewOrder?(seed: { column: SheetColumnId; value: string; customerId?: string }): Promise<void>
  bulk: ReadonlyArray<{ id: string; words: string; icon: string; primary?: boolean; run(keys: readonly string[]): void }>
  live?: { lastChange: string | null; flashKeys: readonly string[] }
  loading: boolean
  error: string | null
}
