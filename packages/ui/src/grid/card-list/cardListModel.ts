/**
 * The rules of `GridCardList` (B-W2b-09, D3 / A2 gap G22; design 00-page-anatomy §2.1 item 10: "Phone (< 720 px): a card
 * list with the same columns, sort and filter; bulk through a Select mode") — pure, tested in Node.
 *
 * The cards are drawn from the list's OWN columns (`ColDef`s), so a phone shows what the table shows, never a second
 * definition that drifts: the first shown column is the card's title (the row's link), a column without a header is its
 * actions (the ⋯ menu), the rest are label: value lines. A column's value is its `valueGetter` (or `field`) through its
 * `valueFormatter`; its drawing is its `cellRenderer` with the row (`{ data, value, valueFormatted }`) — the factory's
 * renderers draw from `data`. A host overrides a column's place or drawing per column id (`fields`).
 *
 * Selection is the list's: the same ids, `isRowSelectable` reasons, select all over the rows that may be selected.
 */
import { createElement, type ComponentType, type ReactNode } from 'react'
import type { ColDef } from 'ag-grid-community'

/** The AG selection column (never a card field). */
const SELECTION_COLUMN = 'ag-Grid-SelectionColumn'

/** Below this width (px) a list is drawn as cards (design: "Phone (< 720 px)"). */
export const CARD_LIST_BELOW = 720

export type CardFieldRole = 'title' | 'subtitle' | 'aside' | 'field' | 'actions' | 'hidden'

export interface CardField<T> {
  id: string
  /** The column's header words. */
  label: string
  role: CardFieldRole
  /** The column may be sorted by. */
  sortable: boolean
  /** The value in plain text (the formatted value): names a card, sorts nothing (the list sorts). */
  text: (row: T) => string
  /** What the card draws for this column. */
  draw: (row: T) => ReactNode
}

export interface CardFieldOverride<T> {
  role?: CardFieldRole
  /** The card's drawing for this column (instead of its cell renderer). */
  draw?: (row: T) => ReactNode
  /** The words in front of the value (default: the header). */
  label?: string
}

const colIdOf = (col: ColDef<unknown>): string | null => col.colId ?? (typeof col.field === 'string' ? col.field : null)

function fieldValue(row: unknown, path: string): unknown {
  let value: unknown = row
  for (const part of path.split('.')) {
    if (value == null || typeof value !== 'object') return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/** The column's value for a row: its `valueGetter` (a function) or its `field`; undefined when it cannot be read. */
export function columnValue<T>(col: ColDef<T>, row: T): unknown {
  try {
    if (typeof col.valueGetter === 'function') return (col.valueGetter as (params: unknown) => unknown)({ data: row, colDef: col, getValue: (field: string) => fieldValue(row, field) })
    if (typeof col.field === 'string') return fieldValue(row, col.field)
  } catch {
    return undefined
  }
  return undefined
}

/** The column's value as the table writes it: through its `valueFormatter` (a function), else as text. */
export function columnText<T>(col: ColDef<T>, row: T): string {
  const value = columnValue(col, row)
  try {
    if (typeof col.valueFormatter === 'function') {
      const out = (col.valueFormatter as (params: unknown) => unknown)({ value, data: row, colDef: col })
      return out == null ? '' : String(out)
    }
  } catch {
    // fall through to the plain value
  }
  if (value == null) return ''
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return value.toISOString()
  return ''
}

/**
 * The card's fields from the list's columns, in the table's order: hidden columns and the selection column left out;
 * the first shown column with a header is the title; a column with no header is the actions; the rest are fields —
 * unless `overrides` place a column elsewhere ('hidden' leaves it off the card).
 */
export function cardFieldsOf<T>(columns: readonly ColDef<T>[], overrides: Readonly<Record<string, CardFieldOverride<T>>> = {}): CardField<T>[] {
  const fields: CardField<T>[] = []
  let titled = Object.values(overrides).some((override) => override?.role === 'title')
  for (const col of columns) {
    const id = colIdOf(col as ColDef<unknown>)
    if (!id || id === SELECTION_COLUMN || col.hide) continue
    const override = overrides[id] ?? {}
    const header = typeof col.headerName === 'string' ? col.headerName : ''
    let role: CardFieldRole = override.role ?? (header ? 'field' : 'actions')
    if (!override.role && role === 'field' && !titled) {
      role = 'title'
      titled = true
    }
    if (role === 'hidden') continue
    const renderer = col.cellRenderer
    const draw = override.draw
      ?? (typeof renderer === 'function'
        ? (row: T) => {
            const value = columnValue(col, row)
            const Cell = renderer as ComponentType<{ data: T; value: unknown; valueFormatted: string; colDef: ColDef<T> }>
            return createElement(Cell, { data: row, value, valueFormatted: columnText(col, row), colDef: col })
          }
        : (row: T) => columnText(col, row))
    fields.push({ id, label: override.label ?? header, role, sortable: col.sortable !== false && !!header, text: (row) => columnText(col, row), draw })
  }
  return fields
}

export interface CardSort {
  colId: string
  dir: 'asc' | 'desc'
}

/** The sort control's choices: the list order, then each sortable field up and down. Value = "colId:dir" or "". */
export function cardSortChoices<T>(fields: readonly CardField<T>[]): Array<{ value: string; colId: string | null; dir: CardSort['dir'] | null; label: string }> {
  const choices: Array<{ value: string; colId: string | null; dir: CardSort['dir'] | null; label: string }> = [{ value: '', colId: null, dir: null, label: '' }]
  for (const field of fields) {
    if (!field.sortable || field.role === 'actions') continue
    choices.push({ value: `${field.id}:asc`, colId: field.id, dir: 'asc', label: field.label })
    choices.push({ value: `${field.id}:desc`, colId: field.id, dir: 'desc', label: field.label })
  }
  return choices
}

export const cardSortValue = (sort: CardSort | null | undefined): string => (sort ? `${sort.colId}:${sort.dir}` : '')

export function cardSortFrom(value: string): CardSort | null {
  const at = value.lastIndexOf(':')
  if (at <= 0) return null
  const dir = value.slice(at + 1)
  return dir === 'asc' || dir === 'desc' ? { colId: value.slice(0, at), dir } : null
}

export interface CardSelection {
  /** Ids of the loaded rows that may be selected. */
  selectable: string[]
  /** Every selectable loaded row is selected. */
  all: boolean
  /** Some, not all. */
  some: boolean
  count: number
}

export function cardSelection<T>(rows: readonly T[], selected: readonly string[], rowId: (row: T) => string, isRowSelectable?: (row: T) => string | null): CardSelection {
  const selectable = rows.filter((row) => !isRowSelectable?.(row)).map(rowId)
  const set = new Set(selected)
  const on = selectable.filter((id) => set.has(id)).length
  return { selectable, all: selectable.length > 0 && on === selectable.length, some: on > 0 && on < selectable.length, count: selected.length }
}

/** The selection after the header box: all selectable loaded rows, or none of them (rows not loaded stay as they were). */
export function cardToggleAll(selection: CardSelection, selected: readonly string[]): string[] {
  const set = new Set(selected)
  if (selection.all) for (const id of selection.selectable) set.delete(id)
  else for (const id of selection.selectable) set.add(id)
  return [...set]
}

export function cardToggle(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((entry) => entry !== id) : [...selected, id]
}
