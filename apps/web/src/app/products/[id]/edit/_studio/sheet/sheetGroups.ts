/**
 * The product sheet's column groups on the web side (2026-10-01, `docs/product-sheet-groups/PLAN-2026-10-01.md`).
 *
 * The SERVER puts every column in its group — the Amazon group names, order and one colour each, on every sheet
 * (`@nexus/shared/sheet-groups`). This file does the rest, on the sheet only:
 *   1. the columns the sheet adds itself join those groups — Progress leads Offer Identity, Product media leads Images;
 *   2. a layout saved before the current groups keeps its columns and pins but drops its old ORDER, so the groups' order
 *      shows (its group keys name groups that no longer exist);
 *   3. each column NAME in the header takes its group's tint and a slight indent, and the first column of a group
 *      draws its group's edge — there is no band row (the Owner: Customise manages what shows).
 */
import { SHEET_GROUPS, isSheetGroupKey, sheetGroupRank, type SheetGroupDef, type SheetTone } from '@nexus/shared/sheet-groups'
import type { ColDef, ColGroupDef } from '@/design-system/grid'
import type { ColumnsViewPayload } from '@/design-system/grid/views/viewPayload'

/** The media column's key (`media/productMediaColumn.tsx`), restated so this file stays free of the media editor. */
export const SHEET_MEDIA_COLUMN = 'productMedia'

interface Groupable {
  key: string
  group: string
  groupKey?: string
  groupTone?: SheetTone
  managedBy?: string
  /** A language column's own field group (its `groupKey` is the language split's). */
  sourceGroupKey?: string
}

/** Every key the sheet's groups use. */
const SHEET_GROUP_KEYS: ReadonlySet<string> = new Set(Object.values(SHEET_GROUPS).map((g) => g.key))

/** True when the server put this sheet's columns in the sheet groups (every sheet since 2026-10-01). */
export const sheetGrouped = (columns: readonly { groupKey?: string; sourceGroupKey?: string }[]): boolean =>
  columns.some((c) => isSheetGroupKey(c.groupKey) || isSheetGroupKey(c.sourceGroupKey))

/**
 * The sheet's own columns in the groups — Progress leads Offer Identity, Product media leads Images — and every column
 * in its group's place. Idempotent; a sheet the server did not group is returned as it is.
 */
export function withSheetGroups<T extends Groupable>(columns: readonly T[]): T[] {
  if (!sheetGrouped(columns)) return [...columns]
  const join = (c: T, to: SheetGroupDef): T => ({ ...c, group: to.label, groupKey: to.key, groupTone: to.tone })
  const placed = columns.map((c, index) => {
    const column = c.managedBy === 'progress' ? join(c, SHEET_GROUPS.offerIdentity) : c.key === SHEET_MEDIA_COLUMN ? join(c, SHEET_GROUPS.images) : c
    const leads = c.managedBy === 'progress' || c.key === SHEET_MEDIA_COLUMN
    return { column, index, rank: sheetGroupRank(column.sourceGroupKey ?? column.groupKey) * 2 + (leads ? 0 : 1) }
  })
  return placed.sort((a, b) => a.rank - b.rank || a.index - b.index).map(({ column }) => column)
}

/**
 * A layout saved before the current groups: its columns, hidden columns and pins stay; its column ORDER, group order and
 * group moves are dropped — they name groups that no longer exist, and keeping them would scatter the groups' order. A
 * layout saved since (its group order names today's groups and no retired one) is the operator's and is kept as it is.
 */
export function withoutPreGroupingOrder<P extends ColumnsViewPayload>(payload: P, grouped: boolean): P {
  if (!grouped || payload.v !== 3) return payload
  const current = payload.groupOrder.some((k) => SHEET_GROUP_KEYS.has(k)) && !payload.groupOrder.some((k) => isSheetGroupKey(k) && !SHEET_GROUP_KEYS.has(k))
  return current ? payload : { ...payload, columnOrder: [], groupOrder: [], groupOverrides: {} }
}

/**
 * `keys` with each of `extra` put back where `natural` has it: after the last key that comes before it in `natural`
 * (first when none does). How the always-shown variation theme keeps its seat in its group.
 */
export function insertInNaturalOrder(keys: readonly string[], extra: readonly string[], natural: readonly string[]): string[] {
  const out = keys.filter((k) => !extra.includes(k))
  const rank = new Map(natural.map((k, i) => [k, i]))
  for (const key of extra) {
    const at = rank.get(key)
    if (at === undefined) { out.push(key); continue }
    let index = 0
    out.forEach((k, i) => { const r = rank.get(k); if (r !== undefined && r < at) index = i + 1 })
    out.splice(index, 0, key)
  }
  return out
}

/* ── the header ─────────────────────────────────────────────────────────────────────────────────────────────── */

type HeaderClassFn = Extract<NonNullable<ColDef['headerClass']>, (...args: never[]) => unknown>
export type SheetHeaderClassParams = Parameters<HeaderClassFn>[0]
export interface SheetHeaderGroup { group: string; tone?: string }

/** The classes a column name takes: its group's tint and indent, and the group's edge on the first column of a group. */
export function sheetHeaderClasses(params: SheetHeaderClassParams, groupOf: (colId: string) => SheetHeaderGroup | undefined): string[] {
  const column = params.column
  if (!column) return []
  const here = groupOf(column.getColId())
  if (!here?.tone) return []
  const before = params.api.getDisplayedColBefore(column)
  const previous = before ? groupOf(before.getColId()) : undefined
  return ['nds-ag-head-tone', `nds-ag-head-tone--${here.tone}`, ...(previous?.group === here.group ? [] : ['nds-ag-head-tone--start'])]
}

const asList = (value: string | string[] | null | undefined): string[] => (value == null ? [] : Array.isArray(value) ? value : [value])

/** The sheet's column defs, each name also carrying its group's classes (a def's own header class is kept). */
export function withGroupHeaderClass<T>(defs: ReadonlyArray<ColDef<T> | ColGroupDef<T>>, groupClasses: (params: SheetHeaderClassParams) => string[]): Array<ColDef<T> | ColGroupDef<T>> {
  return defs.map((def) => {
    if ('children' in def) return { ...def, children: withGroupHeaderClass(def.children, groupClasses) }
    const own = def.headerClass
    return {
      ...def,
      headerClass: (params: SheetHeaderClassParams) => [
        ...asList(typeof own === 'function' ? (own as HeaderClassFn)(params as never) as string | string[] | undefined : own),
        ...groupClasses(params),
      ],
    } as ColDef<T>
  })
}
