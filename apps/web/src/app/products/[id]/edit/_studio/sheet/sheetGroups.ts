/**
 * The product sheet's column groups on the web side (2026-10-01, `docs/product-sheet-groups/PLAN-2026-10-01.md`).
 *
 * The SERVER groups, orders and colours the columns like the old flat file (`@nexus/shared/sheet-groups`). This file
 * does the rest, on the sheet only:
 *   1. the columns the sheet adds itself join those groups — Progress the first group, Product media the Images group;
 *   2. a layout saved before the regrouping keeps its columns and pins but drops its old ORDER, so the flat file's order
 *      shows (its group keys name groups that no longer exist);
 *   3. each column NAME in the header takes its group's tint and a slight indent, and the first column of a group
 *      draws its group's edge — there is no band row (the Owner: Customise manages what shows).
 */
import { IMAGES_GROUP_SUFFIX, isFlatFileGroupKey, sheetGroupTone, type SheetTone } from '@nexus/shared/sheet-groups'
import { PRODUCT_ROLE_COLUMN } from '@nexus/shared/master-sheet'
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
}

/** True when the server grouped this sheet like the old flat file (eBay, Amazon). */
export const flatFileGrouped = (columns: readonly { groupKey?: string }[]): boolean => columns.some((c) => isFlatFileGroupKey(c.groupKey))

/**
 * Every column with its group's colour; on a flat-file sheet the progress columns join the first group (Identifiers /
 * Offer Identity, where the relationship columns are) and Product media leads the Images group. Idempotent.
 */
export function withSheetGroups<T extends Groupable>(columns: readonly T[]): T[] {
  const toned = (c: T): T => (c.groupTone ? c : { ...c, groupTone: sheetGroupTone(c.groupKey, c.group) })
  if (!flatFileGrouped(columns)) return columns.map(toned)
  const home = columns.find((c) => c.key === PRODUCT_ROLE_COLUMN) ?? columns.find((c) => c.managedBy !== 'progress' && isFlatFileGroupKey(c.groupKey))
  const images = columns.find((c) => c.key !== SHEET_MEDIA_COLUMN && isFlatFileGroupKey(c.groupKey) && c.groupKey!.endsWith(IMAGES_GROUP_SUFFIX))
  const join = (c: T, to: T): T => ({ ...c, group: to.group, groupKey: to.groupKey, groupTone: to.groupTone })
  const placed = columns.map((c) => c.managedBy === 'progress' && home ? join(c, home)
    : c.key === SHEET_MEDIA_COLUMN && images ? join(c, images)
      : toned(c))
  const media = placed.findIndex((c) => c.key === SHEET_MEDIA_COLUMN)
  if (media < 0 || !images) return placed
  const [column] = placed.splice(media, 1)
  placed.splice(placed.findIndex((c) => c.groupKey === images.groupKey), 0, column)
  return placed
}

/**
 * A layout saved before the sheet took the flat file's groups: its columns, hidden columns and pins stay; its column
 * ORDER, group order and group moves are dropped — they name the old groups, and keeping them would scatter the flat
 * file's order. A layout saved since (it lists a flat-file group) is the operator's and is returned as it is.
 */
export function withoutPreGroupingOrder<P extends ColumnsViewPayload>(payload: P, flatFile: boolean): P {
  if (!flatFile || payload.v !== 3 || payload.groupOrder.some(isFlatFileGroupKey)) return payload
  return { ...payload, columnOrder: [], groupOrder: [], groupOverrides: {} }
}

/**
 * `keys` with each of `extra` put back where `natural` has it: after the last key that comes before it in `natural`
 * (first when none does). How the always-shown variation theme keeps its seat in Listing / Variations.
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
