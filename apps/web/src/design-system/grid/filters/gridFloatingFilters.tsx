'use client'

/**
 * GDS / PES.2 — the FLOATING filter row: a filter input under each header, always visible.
 *
 * Why a sheet needs it and a list does not. On `/products/next` a filter is a considered act — open
 * the column menu, choose from a set, close it — and the accordion above the grid carries the ones
 * that matter. A sheet is the opposite: an operator working a 102-column enrichment surface narrows
 * and re-narrows constantly ("show me the rows missing fabric_type, in Nero, over €80"), and a
 * filter that costs two clicks per column is a filter they stop using. Rithum's own grid puts the
 * inputs in the header for exactly this reason, and the approved layout asks for them by name.
 *
 * These are the SAME models and the SAME predicates as the column-menu filters beside them
 * (`gridFilters.tsx`, `filterPredicates.ts`) — a floating filter is a second VIEW of one filter,
 * never a second filter. Type in the box and the menu shows it; pick in the menu and the box shows
 * it. AG keeps them in step through `props.model`; nothing here holds filter state of its own.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useGridFloatingFilter, type CustomFloatingFilterProps } from 'ag-grid-react'

import type { GridNumberFilterModel, GridSetFilterModel, GridTextFilterModel } from '@nexus/shared/products-grid'

import { Input } from '@/design-system/primitives'

/**
 * A draft that commits after a pause and follows the model when it changes from elsewhere — the
 * column menu, a saved view, a Clear. Same contract as the menu filters' own draft hook; kept
 * separate because a floating filter must also survive the model being set while it is unfocused.
 */
function useFloatingDraft(applied: string, commit: (value: string) => void, ms = 250) {
  const [draft, setDraft] = useState(applied)
  const dirty = useRef(false)
  useEffect(() => {
    if (!dirty.current) setDraft(applied)
  }, [applied])
  useEffect(() => {
    if (!dirty.current) return
    const t = setTimeout(() => {
      dirty.current = false
      commit(draft)
    }, ms)
    return () => clearTimeout(t)
  }, [draft, commit, ms])
  return [draft, (next: string) => { dirty.current = true; setDraft(next) }] as const
}

/**
 * `useGridFloatingFilter` registers the component with AG. Its callback object
 * (`BaseFloatingFilter`) carries only an optional `afterGuiAttached`, and none of these needs it:
 * a React floating filter follows the parent filter through `props.model`, not through the
 * `onParentModelChanged` callback the JS interface uses.
 */
const NO_CALLBACKS = {}

export function GridTextFloatingFilter(props: CustomFloatingFilterProps<never, unknown, unknown, GridTextFilterModel>) {
  useGridFloatingFilter(NO_CALLBACKS)
  const { onModelChange } = props
  const commit = useCallback(
    (d: string) => onModelChange(d.trim() ? { filterType: 'text', type: 'contains', filter: d.trim() } : null),
    [onModelChange],
  )
  const [draft, edit] = useFloatingDraft(props.model?.filter ?? '', commit)
  return (
    <div className="nds-ag-floating">
      <Input
        value={draft}
        onChange={(e) => edit(e.target.value)}
        placeholder="Filter…"
        aria-label={`Filter ${props.column.getColDef().headerName ?? ''}`.trim()}
        className="nds-ag-floating-input"
      />
    </div>
  )
}

const bound = (s: string): number | null => {
  const t = s.trim()
  if (t === '') return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}
const boundText = (n: number | null | undefined) => (n == null ? '' : String(n))

/**
 * Two fields, min and max — the shape the column menu offers, at header width. Each commits with
 * the other read from its own input, so typing in one never clears the other.
 */
export function GridNumberRangeFloatingFilter(props: CustomFloatingFilterProps<never, unknown, unknown, GridNumberFilterModel>) {
  useGridFloatingFilter(NO_CALLBACKS)
  const { onModelChange } = props
  const minRef = useRef<HTMLInputElement>(null)
  const maxRef = useRef<HTMLInputElement>(null)
  const commitRange = useCallback(
    (lo: string, hi: string) => {
      const filter = bound(lo)
      const filterTo = bound(hi)
      onModelChange(filter == null && filterTo == null ? null : { filterType: 'number', type: 'inRange', filter, filterTo })
    },
    [onModelChange],
  )
  const commitMin = useCallback((d: string) => commitRange(d, maxRef.current?.value ?? ''), [commitRange])
  const commitMax = useCallback((d: string) => commitRange(minRef.current?.value ?? '', d), [commitRange])
  const [min, editMin] = useFloatingDraft(boundText(props.model?.filter), commitMin)
  const [max, editMax] = useFloatingDraft(boundText(props.model?.filterTo), commitMax)
  const label = props.column.getColDef().headerName ?? ''
  return (
    <div className="nds-ag-floating nds-ag-floating-range">
      <Input ref={minRef} inputMode="decimal" value={min} onChange={(e) => editMin(e.target.value)} placeholder="Min" aria-label={`Minimum ${label}`.trim()} className="nds-ag-floating-input" />
      <Input ref={maxRef} inputMode="decimal" value={max} onChange={(e) => editMax(e.target.value)} placeholder="Max" aria-label={`Maximum ${label}`.trim()} className="nds-ag-floating-input" />
    </div>
  )
}

/**
 * The set filter's floating half is a READ-OUT, not a second list.
 *
 * A tick-list does not fit a header row, and squeezing one in would give the operator a control
 * that can only ever show its first two options — so this reports what is selected and opens the
 * real list on click. AG's own set floating filter makes the same call. It is a button because it
 * does something; a div with a click handler would be a control the keyboard cannot reach.
 */
export function GridSetFloatingFilter(props: CustomFloatingFilterProps<never, unknown, unknown, GridSetFilterModel>) {
  useGridFloatingFilter(NO_CALLBACKS)
  const values = props.model?.values ?? []
  const label = props.column.getColDef().headerName ?? ''
  const text = values.length === 0 ? 'All' : values.length === 1 ? values[0] : `${values.length} selected`
  return (
    <div className="nds-ag-floating">
      <button
        type="button"
        className={`nds-ag-floating-set${values.length ? ' nds-ag-floating-set-on' : ''}`}
        onClick={() => props.api.showColumnFilter(props.column)}
        title={values.length ? `${label}: ${values.join(', ')}` : `Filter ${label}`}
      >
        {text}
      </button>
    </div>
  )
}
