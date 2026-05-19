'use client'

/**
 * Shared FilterPopover — unified secondary-filter UX across all grid
 * workspaces.
 *
 * Pages configure their dimensions; the popover handles all the
 * interaction (anchor positioning, outside-click dismiss, per-
 * dimension select-all / clear / count badges, search-within for
 * large facets, footer with active count + clear-all). FP.2 layers
 * drag-to-reorder on top of this; FP.3-6 wire onto each workspace.
 *
 * Preset filter chips (Active / Draft / All) stay on the workspaces
 * for hot paths — this popover hosts the secondary dimensions
 * cleanly so the table area isn't cluttered with eight inline filters.
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Filter as FilterIcon, Search, X } from 'lucide-react'

export interface FilterOption {
  value: string
  label: string
  /** Optional facet count — renders as a muted number next to the label. */
  count?: number
}

export type FilterDimension =
  | {
      key: string
      label: string
      type: 'multi-select'
      options: ReadonlyArray<FilterOption>
      values: ReadonlyArray<string>
      onChange: (next: string[]) => void
      /** When true, a search input pinned at the top of the list filters the options client-side. */
      searchable?: boolean
    }
  | {
      key: string
      label: string
      type: 'single-select'
      options: ReadonlyArray<FilterOption>
      value: string | null
      onChange: (next: string | null) => void
    }
  | {
      key: string
      label: string
      type: 'toggle'
      value: boolean
      onChange: (next: boolean) => void
    }

export interface FilterPopoverProps {
  dimensions: ReadonlyArray<FilterDimension>
  /** Called when the operator hits the footer Clear-all button. */
  onClearAll: () => void
  /** Sum of active filters across all dimensions; drives the button badge. */
  activeCount: number
  /** Override the button copy (default "Filter"). */
  buttonLabel?: string
}

function activeCountFor(d: FilterDimension): number {
  switch (d.type) {
    case 'multi-select':  return d.values.length
    case 'single-select': return d.value ? 1 : 0
    case 'toggle':        return d.value ? 1 : 0
  }
}

export function FilterPopover({ dimensions, onClearAll, activeCount, buttonLabel }: FilterPopoverProps) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  // Outside click + Escape close the popover.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node)) return
      if (btnRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((s) => !s)}
        className={`h-8 px-3 text-sm border rounded-md inline-flex items-center gap-1.5 transition-colors ${
          open
            ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100'
            : activeCount > 0
            ? 'border-slate-400 dark:border-slate-600 bg-slate-50 dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700'
            : 'border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
        }`}
      >
        <FilterIcon size={13} />
        {buttonLabel ?? 'Filter'}
        {activeCount > 0 && (
          <span
            className={`text-xs px-1.5 py-0.5 rounded-full font-semibold ${
              open
                ? 'bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100'
                : 'bg-slate-700 text-white dark:bg-slate-300 dark:text-slate-900'
            }`}
          >
            {activeCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={popRef}
          className="absolute right-0 top-full mt-1 z-40 w-[480px] max-w-[calc(100vw-2rem)] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md shadow-xl"
          role="dialog"
          aria-label="Filters"
        >
          <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-200 dark:border-slate-800">
            <div className="text-sm font-semibold text-slate-700 dark:text-slate-200 inline-flex items-center gap-2">
              Filters
              {activeCount > 0 && (
                <span className="text-xs px-1.5 py-0.5 rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 tabular-nums">
                  {activeCount} active
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-6 w-6 inline-flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded"
              aria-label="Close filters"
            >
              <X size={12} />
            </button>
          </div>

          <div className="max-h-[60vh] overflow-y-auto p-2">
            {dimensions.map((d) => (
              <DimensionCard key={d.key} dimension={d} />
            ))}
            {dimensions.length === 0 && (
              <div className="text-sm text-slate-500 dark:text-slate-400 italic px-2 py-4 text-center">
                No filters configured for this page.
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-slate-200 dark:border-slate-800">
            <button
              type="button"
              onClick={onClearAll}
              disabled={activeCount === 0}
              className="text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Clear all
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="h-7 px-3 text-sm bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded hover:bg-slate-800 dark:hover:bg-slate-200"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function DimensionCard({ dimension }: { dimension: FilterDimension }) {
  const [collapsed, setCollapsed] = useState(false)
  const active = activeCountFor(dimension)

  return (
    <div className="border-b border-slate-100 dark:border-slate-800 last:border-0">
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        className="w-full flex items-center justify-between gap-2 px-2 py-2 hover:bg-slate-50 dark:hover:bg-slate-800 rounded text-left"
      >
        <span className="text-sm font-medium text-slate-700 dark:text-slate-200 inline-flex items-center gap-2">
          {dimension.label}
          {active > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-blue-50 dark:bg-blue-950/40 text-blue-700 dark:text-blue-300 tabular-nums font-semibold">
              {active}
            </span>
          )}
        </span>
        <ChevronDown
          size={13}
          className={`text-slate-400 dark:text-slate-500 transition-transform ${collapsed ? '-rotate-90' : ''}`}
        />
      </button>
      {!collapsed && (
        <div className="px-2 pb-2">
          {dimension.type === 'multi-select' && <MultiSelectBody dimension={dimension} />}
          {dimension.type === 'single-select' && <SingleSelectBody dimension={dimension} />}
          {dimension.type === 'toggle' && <ToggleBody dimension={dimension} />}
        </div>
      )}
    </div>
  )
}

function MultiSelectBody({ dimension }: { dimension: Extract<FilterDimension, { type: 'multi-select' }> }) {
  const [query, setQuery] = useState('')
  const optionsFiltered = query.trim().length === 0
    ? dimension.options
    : dimension.options.filter((o) =>
        o.label.toLowerCase().includes(query.trim().toLowerCase()) ||
        o.value.toLowerCase().includes(query.trim().toLowerCase()),
      )
  const valuesSet = new Set(dimension.values)
  const allSelected = optionsFiltered.length > 0 && optionsFiltered.every((o) => valuesSet.has(o.value))

  const toggle = (value: string) => {
    if (valuesSet.has(value)) dimension.onChange(dimension.values.filter((v) => v !== value))
    else dimension.onChange([...dimension.values, value])
  }
  const selectAll = () => {
    const union = new Set([...dimension.values, ...optionsFiltered.map((o) => o.value)])
    dimension.onChange([...union])
  }
  const clear = () => {
    const filteredOff = new Set(optionsFiltered.map((o) => o.value))
    dimension.onChange(dimension.values.filter((v) => !filteredOff.has(v)))
  }

  return (
    <div className="space-y-1.5">
      {dimension.searchable && (
        <div className="relative">
          <Search size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder={`Search ${dimension.label.toLowerCase()}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="w-full h-7 pl-6 pr-2 text-sm border border-slate-200 dark:border-slate-700 rounded bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100"
          />
        </div>
      )}
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500 dark:text-slate-400 tabular-nums">
          {dimension.values.length} / {dimension.options.length} selected
        </span>
        <span className="inline-flex items-center gap-2">
          <button
            type="button"
            onClick={selectAll}
            disabled={allSelected}
            className="text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Select all
          </button>
          <span className="text-slate-300 dark:text-slate-600">·</span>
          <button
            type="button"
            onClick={clear}
            disabled={dimension.values.length === 0}
            className="text-slate-600 dark:text-slate-400 hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Clear
          </button>
        </span>
      </div>
      <ul className="max-h-44 overflow-y-auto space-y-0.5">
        {optionsFiltered.map((opt) => {
          const checked = valuesSet.has(opt.value)
          return (
            <li key={opt.value}>
              <label className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(opt.value)}
                  className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
                />
                <span className="flex-1 text-sm text-slate-700 dark:text-slate-300">{opt.label}</span>
                {opt.count != null && (
                  <span className="text-xs text-slate-400 dark:text-slate-500 tabular-nums">{opt.count}</span>
                )}
              </label>
            </li>
          )
        })}
        {optionsFiltered.length === 0 && (
          <li className="text-sm text-slate-400 dark:text-slate-500 italic px-1.5 py-2 text-center">
            No options match "{query}".
          </li>
        )}
      </ul>
    </div>
  )
}

function SingleSelectBody({ dimension }: { dimension: Extract<FilterDimension, { type: 'single-select' }> }) {
  return (
    <ul className="space-y-0.5">
      {dimension.options.map((opt) => {
        const checked = dimension.value === opt.value
        return (
          <li key={opt.value}>
            <label className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
              <input
                type="radio"
                name={dimension.key}
                checked={checked}
                onChange={() => dimension.onChange(opt.value)}
                className="border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
              />
              <span className="flex-1 text-sm text-slate-700 dark:text-slate-300">{opt.label}</span>
              {opt.count != null && (
                <span className="text-xs text-slate-400 dark:text-slate-500 tabular-nums">{opt.count}</span>
              )}
            </label>
          </li>
        )
      })}
      {dimension.value != null && (
        <li className="pt-1">
          <button
            type="button"
            onClick={() => dimension.onChange(null)}
            className="text-xs text-slate-500 dark:text-slate-400 hover:underline px-1.5"
          >
            Clear
          </button>
        </li>
      )}
    </ul>
  )
}

function ToggleBody({ dimension }: { dimension: Extract<FilterDimension, { type: 'toggle' }> }) {
  return (
    <label className="flex items-center gap-2 px-1.5 py-1 rounded hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer">
      <input
        type="checkbox"
        checked={dimension.value}
        onChange={(e) => dimension.onChange(e.target.checked)}
        className="rounded border-slate-300 dark:border-slate-600 text-blue-600 focus:ring-blue-500"
      />
      <span className="flex-1 text-sm text-slate-700 dark:text-slate-300">Enabled</span>
    </label>
  )
}
