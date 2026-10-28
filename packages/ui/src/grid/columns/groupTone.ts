/**
 * Column-group colours in the header — ONE helper for every grid that colours its groups (2026-10-01 the product
 * sheet; 2026-10-08 the Matrix, Owner: "colour the groups … just like the product information page").
 *
 * A column NAME takes its group's tint and a slight step in; the first column of a group draws the group's edge. A
 * group header cell (a grid with a band row, like the Matrix) takes the same tint and edge. The tones are
 * `tokens/groupTones.ts` (`--nds-grid-tone-<tone>-*`); the classes are `grid/theme/grid.css` (`.nds-ag-head-tone*`).
 * What a column's group and tone ARE is the page's own rule (the sheet: the attribute group's kind; the Matrix: the
 * channel) — passed in as `groupOf`.
 */
import type { ColDef, ColGroupDef } from 'ag-grid-community'

type HeaderClassFn = Extract<NonNullable<ColDef['headerClass']>, (...args: never[]) => unknown>
export type GroupHeaderClassParams = Parameters<HeaderClassFn>[0]
/** A column's group (any stable name) and its tone (`GroupToneName`; absent = no colour). */
export interface HeaderGroupTone { group: string; tone?: string }

/** The classes a header cell of this tone takes; `start` draws the group's edge. No tone → none. */
export function groupToneClasses(tone: string | null | undefined, start = true): string[] {
  if (!tone) return []
  return ['nds-ag-head-tone', `nds-ag-head-tone--${tone}`, ...(start ? ['nds-ag-head-tone--start'] : [])]
}

/** The classes a column name takes: its group's tint and indent, and the group's edge on the first column of a group. */
export function groupToneHeaderClasses(params: GroupHeaderClassParams, groupOf: (colId: string) => HeaderGroupTone | undefined): string[] {
  const column = params.column
  if (!column) return []
  const here = groupOf(column.getColId())
  if (!here?.tone) return []
  const before = params.api.getDisplayedColBefore(column)
  const previous = before ? groupOf(before.getColId()) : undefined
  return groupToneClasses(here.tone, previous?.group !== here.group)
}

const asList = (value: string | string[] | null | undefined): string[] => (value == null ? [] : Array.isArray(value) ? value : [value])

/** The column defs, each name also carrying its group's classes (a def's own header class is kept; groups recurse). */
export function withGroupHeaderClass<T>(defs: ReadonlyArray<ColDef<T> | ColGroupDef<T>>, groupClasses: (params: GroupHeaderClassParams) => string[]): Array<ColDef<T> | ColGroupDef<T>> {
  return defs.map((def) => {
    if ('children' in def) return { ...def, children: withGroupHeaderClass(def.children, groupClasses) }
    const own = def.headerClass
    return {
      ...def,
      headerClass: (params: GroupHeaderClassParams) => [
        ...asList(typeof own === 'function' ? (own as HeaderClassFn)(params as never) as string | string[] | undefined : own),
        ...groupClasses(params),
      ],
    } as ColDef<T>
  })
}
