/**
 * P1 — full control (fix/product-sheet-editing): where a cell can go back to the value it inherits, on BOTH sheets.
 *
 * One rule per scope, read by the cell menu, a range reset, a column reset and the Delete choice alike, so the four can
 * never disagree about which cells a reset touches. Every reset leaves through the sheet writer with the intent the
 * write path already honours (`reset` / `reset-list`, see `useChannelSheet.commitChannelLanguage` and
 * `masterWrite.ts`): the server removes this layer's own value and the resolver falls back up the cascade.
 *
 * Pure: no React, no AG at runtime. Tested beside this file.
 */
import { familyRowHoldsValue, isProductRelationshipColumn } from '@nexus/shared/master-sheet'
import { cascadeIntent, cascadeOf, hasValue, wholeListWriteField } from './channel/provenance'
import { isCellEditable, offersCascade } from './channel/rows'
import type { ChannelSheetRow } from './channel/types'
import type { ColDef, ColGroupDef } from '@/design-system/grid'
import type { SheetColumn as MasterColumn, StudioRow } from './master/types'
import { shopifyColumnControl } from '../shopify/columnControl'

export type ResetIntent = 'reset' | 'reset-list'

/** A reset this cell has, and what its menu item says. */
export interface ResetOffer {
  intent: ResetIntent
  label: string
  /** A stored formula makes the value: the reset removes the formula first (its last value is kept, then reset). */
  formula: boolean
}

/** One cell a bulk reset writes. */
export interface ResetTarget {
  rowId: string
  colId: string
  intent: ResetIntent
  formula: boolean
}

const label = (formula: boolean, fallback: string) => (formula ? 'Remove formula and reset to inherited' : fallback)

/**
 * Channel: a reset exists where the cascade says the value is THIS listing's own (an override, an old listing text, an
 * AI or outdated translation pinned here). A value that follows Master, or a cell that writes the shared record itself
 * (`writeTarget: 'master'`), has nothing to reset to.
 */
export function channelResetOffer(row: ChannelSheetRow | undefined, colId: string, formula = false): ResetOffer | null {
  const cell = row?.values?.[colId]
  if (!row || !cell || !isCellEditable(cell) || !offersCascade(cell)) return null
  if (cascadeIntent(cascadeOf(cell, row.rowKind), row.rowKind, cell.value ?? null)?.action !== 'reset') return null
  const list = !!wholeListWriteField(cell.writeField)
  return {
    intent: list ? 'reset-list' : 'reset',
    formula,
    label: label(formula, cell.source === 'channelSnapshot' ? 'Follow Shared' : list ? 'Reset list to inherited…' : 'Reset to inherited'),
  }
}

/**
 * Master facts a variation never inherits: their column has no "empty" (the write path turns a reset of `basePrice` or
 * `totalStock` into 0 — report 2 I-16 — and `status`, `lowStockThreshold` are non-null columns). No reset is offered.
 */
export const MASTER_RESET_EXCLUDED: ReadonlySet<string> = new Set(['basePrice', 'totalStock', 'status', 'lowStockThreshold'])

/**
 * Master: a reset exists on a variation's OWN value of a column the family row holds for it (the variation then shows
 * the family's value again), and on a row's own translation (the language then shows the source language again). A
 * family row's source value inherits from nothing, so it has no reset — resetting it would clear the family.
 */
export function masterResetOffer(row: StudioRow | undefined, column: Pick<MasterColumn, 'key' | 'scope' | 'editable' | 'writeField'> & { axis?: boolean; storage?: string },
  formula = false, familyHolds: (column: { key: string; scope: 'global' | 'per_variant'; axis?: boolean; storage?: string }) => boolean = c => c.scope === 'global' || familyRowHoldsValue(c)): ResetOffer | null {
  const cell = row?.values?.[column.key]
  if (!row || !cell || cell.editable === false || column.editable === false) return null
  if (isProductRelationshipColumn(column.key) || MASTER_RESET_EXCLUDED.has(column.writeField ?? column.key)) return null
  const own = cell.inherited !== true && (hasValue(cell.value) || cell.pinned === true || formula)
  if (!own) return null
  if (cell.tier === 'language') return { intent: 'reset', formula, label: label(formula, 'Reset to inherited') }
  if (!row.parentId || row.isParent || !familyHolds(column)) return null
  return { intent: 'reset', formula, label: label(formula, 'Reset to inherited') }
}

/**
 * The reset targets of a set of cells: the cells that have a reset, each once, and a list once per row (every position
 * of one list resets together, and the write path refuses a position on its own).
 */
export function resetTargets(cells: Array<{ rowId: string; colId: string }>, offerOf: (rowId: string, colId: string) => ResetOffer | null,
  listOf: (rowId: string, colId: string) => string | null = () => null): ResetTarget[] {
  const seen = new Set<string>()
  const out: ResetTarget[] = []
  for (const { rowId, colId } of cells) {
    const offer = offerOf(rowId, colId)
    if (!offer) continue
    const key = offer.intent === 'reset-list' ? `${rowId}\u0000list:${listOf(rowId, colId) ?? colId}` : `${rowId}\u0000${colId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ rowId, colId, intent: offer.intent, formula: offer.formula })
  }
  return out
}

/** The minimal slice of AG's API a selection read needs — so the rule is testable without a grid. */
export interface SelectionApi<Row> {
  getCellRanges(): Array<{ startRow?: { rowIndex: number; rowPinned?: string | null } | null; endRow?: { rowIndex: number; rowPinned?: string | null } | null; columns: Array<{ getColId(): string }> }> | null
  getFocusedCell(): { rowIndex: number; rowPinned?: string | null; column: { getColId(): string } } | null
  getDisplayedRowAtIndex(index: number): { data?: Row } | undefined | null
}

/**
 * The cells the operator has selected: every cell of every range, each once, in row then column order; the focused cell
 * when there is no range. Pinned rows are not sheet rows and are left out.
 */
export function selectedCells<Row>(api: SelectionApi<Row>, rowIdOf: (row: Row) => string): Array<{ rowId: string; colId: string; row: Row }> {
  const out: Array<{ rowId: string; colId: string; row: Row }> = []
  const seen = new Set<string>()
  const add = (index: number, colId: string) => {
    const row = api.getDisplayedRowAtIndex(index)?.data
    if (!row) return
    const rowId = rowIdOf(row)
    const key = `${rowId}\u0000${colId}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ rowId, colId, row })
  }
  const ranges = (api.getCellRanges() ?? []).filter(r => r.startRow && r.endRow && !r.startRow.rowPinned && !r.endRow.rowPinned)
  for (const range of ranges) {
    const from = Math.min(range.startRow!.rowIndex, range.endRow!.rowIndex), to = Math.max(range.startRow!.rowIndex, range.endRow!.rowIndex)
    for (let i = from; i <= to; i++) for (const column of range.columns) add(i, column.getColId())
  }
  if (out.length === 0) {
    const focused = api.getFocusedCell()
    if (focused && !focused.rowPinned) add(focused.rowIndex, focused.column.getColId())
  }
  return out
}

/** The column facts the sheet's own verbs need (Set every row…, the resets, the Delete choice). */
export interface SetColumnFacts {
  colId: string
  label: string
  kind?: string
  shape?: string
  options?: string[]
  optionLabels?: Record<string, string>
  mode?: 'strict' | 'open'
  /** `false`: the column takes no "Set every row…" (a Shopify field other than a supported scalar keeps its own draft editor). */
  settable?: boolean
}

/**
 * Which columns the verbs act on: the attribute columns an operator edits. Never the identity, progress, media or
 * relationship columns, the variation theme (its own editor and route), a bullets one cell (its positions are the
 * columns), or a column nobody can edit.
 */
export function controlColumnFacts(col: { key: string; label: string; kind?: string; shape?: string; options?: string[]; optionLabels?: Record<string, string>;
  mode?: 'strict' | 'open'; editable?: boolean; shopifyField?: unknown } | undefined): SetColumnFacts | null {
  if (!col || col.editable === false || isProductRelationshipColumn(col.key) || col.kind === 'variationTheme' || col.shape === 'axes') return null
  if (col.key === 'productMedia' || col.key.startsWith('progress:') || col.key.startsWith('slots:')) return null
  return { colId: col.key, label: col.label, kind: col.kind, shape: col.shape, options: col.options, optionLabels: col.optionLabels, mode: col.mode,
    // A Shopify field takes "Set every row…" only for a supported scalar metafield; the rest keep their own draft editor.
    ...(col.shopifyField ? shopifyColumnControl(col.shopifyField) : {}) }
}

/** "Clear" or "Reset to inherited" — the Delete key's question, asked once for the whole selection. */
export type ClearChoice = 'clear' | 'reset'

/** What the Delete choice offers for these cells: how many can be cleared, and how many reset. */
export function clearChoiceCounts(cells: Array<{ rowId: string; colId: string }>, editable: (rowId: string, colId: string) => boolean,
  offerOf: (rowId: string, colId: string) => ResetOffer | null): { clearable: number; resettable: number } {
  let clearable = 0, resettable = 0
  for (const { rowId, colId } of cells) {
    if (editable(rowId, colId)) clearable++
    if (offerOf(rowId, colId)) resettable++
  }
  return { clearable, resettable }
}

/**
 * Does Delete need to ask? Only where Clear and Reset differ: somewhere a reset exists, or a cleared cell would hide an
 * inherited value (a channel cell, or a variation on Master). A family row or a product on its own has nothing to hide:
 * Delete clears it, as before.
 */
export function deleteAsks(counts: { clearable: number; resettable: number }, hidesInherited: boolean): boolean {
  return counts.resettable > 0 || (counts.clearable > 0 && hidesInherited)
}

/** Delete / Backspace on a cell that is not being edited — the key the sheet answers itself (AG would store a blank). */
export function isClearKey(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'> | null | undefined, editing: boolean): boolean {
  return !!event && !editing && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey && (event.key === 'Delete' || event.key === 'Backspace')
}

/** Shift+F10 or the ContextMenu key on a focused cell opens its menu — the keyboard's right-click. */
export function isMenuKey(event: Pick<KeyboardEvent, 'key' | 'altKey' | 'ctrlKey' | 'metaKey' | 'shiftKey'> | null | undefined): boolean {
  return !!event && !event.altKey && !event.ctrlKey && !event.metaKey && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
}

/**
 * An emptied list leaves as a CLEAR (`null`). The write path takes `null` as "clear" for every shape, while `[]` meets
 * the list's own minimum and is refused ("0 values — Search keywords needs at least 1", report 1 I-10): an operator who
 * removed every value could not save it. An optional channel list (an eBay aspect, min 1 only when sent) is then simply
 * not sent; a required one is stored empty and flagged, like any other missing required value.
 */
export function wireCellValue(value: unknown): unknown {
  return Array.isArray(value) && value.length === 0 ? null : value
}

/**
 * One attribute column with the sheet's own verbs: its header menu items (read through `menuItemsFor` when the menu opens,
 * so the column model never rebuilds for them) and Delete / Backspace kept from AG, which would store a blank without
 * asking (the host's key handler asks instead). A group, or a column the verbs do not act on, is returned unchanged.
 */
export function withControlVerbs<Row, D extends ColDef<Row> | ColGroupDef<Row>>(def: D, controlled: (colId: string) => boolean, menuItemsFor: (colId: string) => unknown[]): D {
  if ('children' in def) return def
  const colId = (def as ColDef<Row>).colId
  if (!colId || !controlled(colId)) return def
  const prior = (def as ColDef<Row>).suppressKeyboardEvent
  return { ...def,
    suppressKeyboardEvent: (p: { event: KeyboardEvent; editing: boolean }) => (typeof prior === 'function' && (prior as (p: unknown) => boolean)(p)) || isClearKey(p.event, p.editing),
    context: { ...((def as ColDef<Row>).context ?? {}), menuItems: () => menuItemsFor(colId) },
  } as D
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The Delete question's words: what each answer does to how many cells, and which button has the focus. */
export function clearChoiceWords(r: { subject: string; clearable: number; resettable: number }) {
  return {
    title: `Delete ${r.subject}?`,
    clear: `Clear stores an empty value in each cell: the value it inherits no longer shows (${count(r.clearable, 'cell')}).`,
    reset: r.resettable
      ? `Reset to inherited removes each cell’s own value, so it shows the value it inherits again (${count(r.resettable, 'cell')}).`
      : 'No selected cell holds a value of its own, so there is nothing to reset.',
    clearLabel: `Clear ${count(r.clearable, 'cell')}`,
    resetLabel: `Reset ${count(r.resettable, 'cell')} to inherited`,
    /* Enter keeps what is inherited when it can; otherwise it cancels — never a silent blank. */
    focus: r.resettable ? 'reset' as const : 'cancel' as const,
  }
}

/** "Set every row…" words: the rows the value lands on, the locked rows it leaves, and the button. */
export function setColumnWords(r: { label: string; rows: number; locked: number }, clearing: boolean) {
  return {
    title: `Set every row · ${r.label}`,
    lead: `One value for ${r.label} on the ${count(r.rows, 'row')} shown, saved together.${r.locked ? ` ${r.locked} locked ${r.locked === 1 ? 'row keeps its' : 'rows keep their'} value.` : ''}`,
    confirm: `${clearing ? 'Clear' : 'Set'} ${count(r.rows, 'row')}`,
  }
}
