'use client'

/**
 * Column filters, built from the design system, mounted by AG Grid.
 *
 * AG's column menu hosts whatever component a column's `filter` names; these are that component
 * for the three shapes the products grid uses — a set (checkbox list with search), a number range,
 * a text "contains". Each one renders DS markup and speaks AG's model: the value it hands
 * `onModelChange` is exactly the entry the server receives in `filterModel`, declared once in
 * `@nexus/shared/products-grid`.
 *
 * ONE filter state. The page's accordion and search box write the same model through
 * `api.setFilterModel`, and these components receive it as `props.model` — so the header's funnel
 * icon, the accordion, a saved view and the request can never disagree about what is filtered.
 *
 * Under the Server-Side Row Model the grid never evaluates a filter itself; `doesFilterPass` is
 * required by the hook and returns true, because the server has already answered.
 */
import { useEffect, useRef, useState } from 'react'
import { useGridFilter, type CustomFilterProps } from 'ag-grid-react'
import { Search } from 'lucide-react'

import type { GridNumberFilterModel, GridSetFilterModel, GridTextFilterModel } from '@nexus/shared/products-grid'

import { searchOptions } from '@/design-system/lib/option-search'
import { Button, Input } from '@/design-system/primitives'

import type { ColDef } from '../NexusGrid'

export interface SetFilterOption {
  value: string
  label: string
}
export interface SetFilterParams {
  options: SetFilterOption[]
  /** Always show the search box; it otherwise appears past seven options. */
  searchable?: boolean
}
export interface NumberRangeFilterParams {
  unit?: string
}

/** The server filters; nothing is evaluated in the browser. */
const SERVER_FILTERS = { doesFilterPass: () => true }

/** A draft that commits after a pause, and follows the model when it changes from outside. */
function useDebouncedDraft(applied: string, commit: (draft: string) => void, ms = 250) {
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
  const edit = (next: string) => {
    dirty.current = true
    setDraft(next)
  }
  return [draft, edit] as const
}

export function GridSetFilter(props: CustomFilterProps<unknown, unknown, GridSetFilterModel>) {
  useGridFilter(SERVER_FILTERS)
  const params = (props.colDef.filterParams ?? {}) as Partial<SetFilterParams>
  const options = params.options ?? []
  const selected = props.model?.values ?? []
  const [q, setQ] = useState('')
  const showSearch = !!params.searchable || options.length > 7
  const matches = showSearch ? searchOptions(q, options, (o) => o.label) : options
  const commit = (values: string[]) => props.onModelChange(values.length ? { filterType: 'set', values } : null)
  const toggle = (v: string) => commit(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v])
  return (
    <div className="nds-ag-filter" role="group" aria-label={`Filter ${props.colDef.headerName ?? ''}`.trim()}>
      {showSearch && (
        <div className="nds-combo-search">
          <Search size={13} aria-hidden />
          <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search options" />
        </div>
      )}
      <div className="nds-ag-filter-list">
        {matches.length === 0 && <div className="nds-combo-empty">No matches</div>}
        {matches.map((o) => (
          <label key={o.value} className={['nds-ms-opt', selected.includes(o.value) ? 'sel' : ''].filter(Boolean).join(' ')}>
            <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
            <span>{o.label}</span>
          </label>
        ))}
      </div>
      <div className="nds-ag-filter-foot">
        <Button size="sm" variant="ghost" disabled={selected.length === 0} onClick={() => commit([])}>
          Clear
        </Button>
      </div>
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

export function GridNumberRangeFilter(props: CustomFilterProps<unknown, unknown, GridNumberFilterModel>) {
  useGridFilter(SERVER_FILTERS)
  const { unit } = (props.colDef.filterParams ?? {}) as Partial<NumberRangeFilterParams>
  // The two fields commit together: a draft on either side re-reads the other from its input.
  const maxRef = useRef<HTMLInputElement>(null)
  const minRef = useRef<HTMLInputElement>(null)
  const { onModelChange } = props
  const commitRange = (lo: string, hi: string) => {
    const filter = bound(lo)
    const filterTo = bound(hi)
    onModelChange(filter == null && filterTo == null ? null : { filterType: 'number', type: 'inRange', filter, filterTo })
  }
  const [min, editMin] = useDebouncedDraft(boundText(props.model?.filter), (d) => commitRange(d, maxRef.current?.value ?? ''))
  const [max, editMax] = useDebouncedDraft(boundText(props.model?.filterTo), (d) => commitRange(minRef.current?.value ?? '', d))
  const active = props.model != null
  return (
    <div className="nds-ag-filter" role="group" aria-label={`Filter ${props.colDef.headerName ?? ''}`.trim()}>
      <div className="nds-ag-filter-range">
        <label>
          <span>Min{unit ? ` (${unit})` : ''}</span>
          <Input ref={minRef} inputMode="decimal" value={min} onChange={(e) => editMin(e.target.value)} placeholder="Min" autoFocus />
        </label>
        <label>
          <span>Max{unit ? ` (${unit})` : ''}</span>
          <Input ref={maxRef} inputMode="decimal" value={max} onChange={(e) => editMax(e.target.value)} placeholder="Max" />
        </label>
      </div>
      <div className="nds-ag-filter-foot">
        <Button size="sm" variant="ghost" disabled={!active} onClick={() => onModelChange(null)}>
          Clear
        </Button>
      </div>
    </div>
  )
}

export function GridTextFilter(props: CustomFilterProps<unknown, unknown, GridTextFilterModel>) {
  useGridFilter(SERVER_FILTERS)
  const { onModelChange } = props
  const [draft, edit] = useDebouncedDraft(props.model?.filter ?? '', (d) =>
    onModelChange(d.trim() ? { filterType: 'text', type: 'contains', filter: d.trim() } : null),
  )
  return (
    <div className="nds-ag-filter" role="group" aria-label={`Filter ${props.colDef.headerName ?? ''}`.trim()}>
      <Input leadingIcon={<Search size={13} aria-hidden />} value={draft} onChange={(e) => edit(e.target.value)} placeholder="Contains…" autoFocus />
      <div className="nds-ag-filter-foot">
        <Button size="sm" variant="ghost" disabled={!props.model} onClick={() => onModelChange(null)}>
          Clear
        </Button>
      </div>
    </div>
  )
}

/** The `ColDef` fragment that mounts one of these on a column. */
export function gridFilterDef(kind: 'set', params: SetFilterParams): Pick<ColDef, 'filter' | 'filterParams'>
export function gridFilterDef(kind: 'number', params?: NumberRangeFilterParams): Pick<ColDef, 'filter' | 'filterParams'>
export function gridFilterDef(kind: 'text'): Pick<ColDef, 'filter' | 'filterParams'>
export function gridFilterDef(kind: 'set' | 'number' | 'text', params?: SetFilterParams | NumberRangeFilterParams): Pick<ColDef, 'filter' | 'filterParams'> {
  const filter = kind === 'set' ? GridSetFilter : kind === 'number' ? GridNumberRangeFilter : GridTextFilter
  return { filter, filterParams: params ?? {} }
}
