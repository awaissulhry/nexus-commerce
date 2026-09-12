'use client'

/**
 * Column filters, built from the design system, mounted by AG Grid.
 *
 * AG's column menu hosts whatever component a column's `filter` names; these are that component
 * for the three shapes the products grid uses — a set (checkbox list with search), a number range,
 * a text "contains". Each one renders DS markup and speaks AG's model: the value it hands
 * `onModelChange` is exactly the entry the server receives in `filterModel`, declared once in
 * `@nexus/shared/products-grid`. The set filter's LIST is the DS `OptionList`, shared with
 * `MultiSelect` — the accordion and the column menu render the same component, not two copies.
 *
 * ONE filter state. The page's accordion and search box write the same model through
 * `api.setFilterModel`, and these components receive it as `props.model` — so the header's funnel
 * icon, the accordion, a saved view and the request can never disagree about what is filtered.
 *
 * BOTH ROW MODELS, one component. Under the Server-Side Row Model the grid never evaluates a filter
 * itself — the server has already answered, and `doesFilterPass` is never called. Under the
 * Client-Side Row Model it is the ONLY thing that filters. These used to share a single
 * `{ doesFilterPass: () => true }`, which was right for SSRM and silently wrong everywhere else: on
 * a client-side grid (the Product Edit Studio's sheet) the funnel lit, the header showed an active
 * filter, and every row passed. The predicates now live in `filterPredicates.ts`, pure and tested,
 * so a filter means the same thing wherever it is mounted.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useGridFilter, type CustomFilterProps } from 'ag-grid-react'
import { Search } from 'lucide-react'

import type { GridNumberFilterModel, GridSetFilterModel, GridTextFilterModel } from '@nexus/shared/products-grid'

import { numberFilterPasses, setFilterPasses, textFilterPasses } from './filterPredicates'
import { GridNumberRangeFloatingFilter, GridSetFloatingFilter, GridTextFloatingFilter } from './gridFloatingFilters'

import { OptionList } from '@/design-system/components/OptionList'
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

/**
 * A filter's `doesFilterPass`, bound to the model it is currently showing.
 *
 * `props.getValue(node)` is AG's own accessor, so a column with a `valueGetter` (every attribute
 * column on the sheet reads out of `row.values`) is filtered on the value the operator can SEE,
 * not on a field that does not exist on the row object.
 */
function usePasses<TModel>(
  model: TModel | null,
  getValue: (node: never) => unknown,
  predicate: (model: TModel | null, value: unknown) => boolean,
) {
  return useCallback(
    (p: { node: unknown }) => predicate(model, getValue(p.node as never)),
    [model, getValue, predicate],
  )
}

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

/**
 * The set filter. The LIST is the DS `OptionList` — the same component the accordion's
 * `MultiSelect` renders inside its popover — so the header-menu filter and the accordion filter
 * are one control, including Select all. This wrapper owns only what AG needs: the filter shell,
 * the model mapping, and Clear.
 *
 * An empty selection is `null`, not `{ values: [] }` — AG reads null as "this column is not
 * filtered", which is what clears the funnel and drops the entry from the request.
 */
export function GridSetFilter(props: CustomFilterProps<unknown, unknown, GridSetFilterModel>) {
  useGridFilter({ doesFilterPass: usePasses(props.model, props.getValue, setFilterPasses) })
  const params = (props.colDef.filterParams ?? {}) as Partial<SetFilterParams>
  const options = params.options ?? []
  const selected = props.model?.values ?? []
  const { onModelChange } = props
  const commit = (values: string[]) => onModelChange(values.length ? { filterType: 'set', values } : null)
  return (
    <div className="nds-ag-filter" role="group" aria-label={`Filter ${props.colDef.headerName ?? ''}`.trim()}>
      <OptionList
        options={options}
        value={selected}
        onChange={commit}
        searchable={params.searchable}
        listClassName="nds-ag-filter-list"
      />
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
  useGridFilter({ doesFilterPass: usePasses(props.model, props.getValue, numberFilterPasses) })
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
  useGridFilter({ doesFilterPass: usePasses(props.model, props.getValue, textFilterPasses) })
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

/**
 * The `ColDef` fragment that mounts one of these on a column — and, with `floating: true`, its
 * inline counterpart in the floating filter row.
 *
 * The floating component is chosen HERE rather than by the caller so the two halves can never be
 * mismatched: a text filter with a number floating filter would write a model its own predicate
 * rejects, and nothing on screen would say why.
 */
export type GridFilterDef = Pick<ColDef, 'filter' | 'filterParams' | 'floatingFilter' | 'floatingFilterComponent'>

export function gridFilterDef(kind: 'set', params: SetFilterParams, opts?: GridFilterOptions): GridFilterDef
export function gridFilterDef(kind: 'number', params?: NumberRangeFilterParams, opts?: GridFilterOptions): GridFilterDef
export function gridFilterDef(kind: 'text', params?: undefined, opts?: GridFilterOptions): GridFilterDef
export function gridFilterDef(
  kind: 'set' | 'number' | 'text',
  params?: SetFilterParams | NumberRangeFilterParams,
  opts: GridFilterOptions = {},
): GridFilterDef {
  const filter = kind === 'set' ? GridSetFilter : kind === 'number' ? GridNumberRangeFilter : GridTextFilter
  const def: GridFilterDef = { filter, filterParams: params ?? {} }
  if (!opts.floating) return def
  const floatingFilterComponent = kind === 'set' ? GridSetFloatingFilter : kind === 'number' ? GridNumberRangeFloatingFilter : GridTextFloatingFilter
  return { ...def, floatingFilter: true, floatingFilterComponent }
}

export interface GridFilterOptions {
  /** Also mount the inline input under the header. Sheets do; paginated lists generally do not. */
  floating?: boolean
}
