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

import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Filter as FilterIcon, GripVertical, Search, X } from 'lucide-react'
import { AnchoredPopover } from './AnchoredPopover'
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'

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
  /**
   * Custom display order. Array of dimension keys; any key not in the
   * array falls back to the source order at the tail. When omitted,
   * the dimensions render in the order they were passed.
   */
  order?: ReadonlyArray<string>
  /**
   * Called when the operator drags a dimension card to a new position.
   * Receives the new full key order. When omitted, drag handles are
   * hidden and reordering is disabled.
   */
  onOrderChange?: (next: string[]) => void
  /**
   * When provided, the footer renders a "Reset order" button that
   * fires this callback. Useful for clearing a persisted custom order.
   */
  onResetOrder?: () => void
  /**
   * When set, the popover subscribes to that custom event on window
   * and opens itself when fired. Lets workspaces preserve "press F to
   * open the filter menu" style shortcuts without lifting the open
   * state out of the popover.
   */
  openEventName?: string
  /**
   * Optional "Save as view" callback. When supplied, the footer
   * renders a button that fires this — pages hook it to their own
   * saved-views modal so the current filter state (URL params, order,
   * etc.) gets captured.
   */
  onSaveView?: () => void
  /** Override the Save-as-view button label (default "Save as view"). */
  saveViewLabel?: string
}

function activeCountFor(d: FilterDimension): number {
  switch (d.type) {
    case 'multi-select':  return d.values.length
    case 'single-select': return d.value ? 1 : 0
    case 'toggle':        return d.value ? 1 : 0
  }
}

interface AppliedChip {
  key: string
  label: string
  value: string | null
  onRemove: () => void
}

function appliedChipsFor(dimensions: ReadonlyArray<FilterDimension>): AppliedChip[] {
  const chips: AppliedChip[] = []
  for (const d of dimensions) {
    if (d.type === 'multi-select') {
      for (const v of d.values) {
        const opt = d.options.find((o) => o.value === v)
        chips.push({
          key: `${d.key}:${v}`,
          label: d.label,
          value: opt?.label ?? v,
          onRemove: () => d.onChange(d.values.filter((x) => x !== v)),
        })
      }
    } else if (d.type === 'single-select') {
      if (d.value) {
        const opt = d.options.find((o) => o.value === d.value)
        chips.push({
          key: d.key,
          label: d.label,
          value: opt?.label ?? d.value,
          onRemove: () => d.onChange(null),
        })
      }
    } else if (d.type === 'toggle') {
      if (d.value) {
        chips.push({
          key: d.key,
          label: d.label,
          value: null,
          onRemove: () => d.onChange(false),
        })
      }
    }
  }
  return chips
}

export function FilterPopover({
  dimensions, onClearAll, activeCount, buttonLabel, order, onOrderChange, onResetOrder,
  openEventName, onSaveView, saveViewLabel,
}: FilterPopoverProps) {
  const [open, setOpen] = useState(false)
  // Mobile sm-and-down: render as a bottom-sheet overlay so the
  // popover doesn't squeeze against the viewport edge. Initialised
  // false for SSR safety; a single matchMedia listener swaps as
  // the viewport crosses the 640px (sm) breakpoint.
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia('(max-width: 639px)')
    const onChange = () => setIsMobile(mql.matches)
    onChange()
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  // Optional: subscribe to a window-level custom event so workspaces
  // can open the popover from a keyboard shortcut handler (bare-F on
  // /products, etc.).
  useEffect(() => {
    if (!openEventName) return
    const handler = () => setOpen(true)
    window.addEventListener(openEventName, handler)
    return () => window.removeEventListener(openEventName, handler)
  }, [openEventName])
  const btnRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)

  const draggable = !!onOrderChange
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  // Apply the persisted order: known keys first (in order), unknown keys
  // appended at the tail in source order. Source order acts as a stable
  // fallback when a new dimension is added that the persisted order
  // doesn't know about yet.
  const orderedDimensions = useMemo(() => {
    if (!order || order.length === 0) return dimensions
    const byKey = new Map(dimensions.map((d) => [d.key, d]))
    const seen = new Set<string>()
    const result: FilterDimension[] = []
    for (const k of order) {
      const d = byKey.get(k)
      if (d) { result.push(d); seen.add(k) }
    }
    for (const d of dimensions) {
      if (!seen.has(d.key)) result.push(d)
    }
    return result
  }, [dimensions, order])

  const appliedChips = useMemo(() => appliedChipsFor(orderedDimensions), [orderedDimensions])

  const onDragEnd = (e: DragEndEvent) => {
    if (!onOrderChange) return
    const { active, over } = e
    if (!over || active.id === over.id) return
    const keys = orderedDimensions.map((d) => d.key)
    const from = keys.indexOf(active.id as string)
    const to = keys.indexOf(over.id as string)
    if (from === -1 || to === -1) return
    onOrderChange(arrayMove(keys, from, to))
  }

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

      {open && isMobile && typeof document !== 'undefined' && createPortal(
        <div
          className="fixed inset-0 z-[1000] bg-slate-900/40 dark:bg-slate-950/60 backdrop-blur-sm flex items-end sm:hidden"
          onMouseDown={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
        >
          <div
            ref={popRef}
            className="w-full bg-white dark:bg-slate-900 rounded-t-xl shadow-2xl max-h-[88vh] flex flex-col"
            role="dialog"
            aria-label="Filters"
          >
            <FilterPopoverContents
              orderedDimensions={orderedDimensions}
              activeCount={activeCount}
              appliedChips={appliedChips}
              draggable={draggable}
              sensors={sensors}
              onDragEnd={onDragEnd}
              onClearAll={onClearAll}
              onResetOrder={onResetOrder}
              onSaveView={onSaveView}
              saveViewLabel={saveViewLabel}
              onClose={() => setOpen(false)}
              bodyMaxHeight="max-h-[calc(88vh-7rem)]"
            />
          </div>
        </div>,
        document.body,
      )}
      {open && !isMobile && (
        <AnchoredPopover
          anchorRef={btnRef}
          onClose={() => setOpen(false)}
          className="w-[480px] bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md shadow-xl"
          ariaLabel="Filters"
        >
          <FilterPopoverContents
            orderedDimensions={orderedDimensions}
            activeCount={activeCount}
            appliedChips={appliedChips}
            draggable={draggable}
            sensors={sensors}
            onDragEnd={onDragEnd}
            onClearAll={onClearAll}
            onResetOrder={onResetOrder}
            onSaveView={onSaveView}
            saveViewLabel={saveViewLabel}
            onClose={() => setOpen(false)}
            bodyMaxHeight="max-h-[60vh]"
          />
        </AnchoredPopover>
      )}
    </div>
  )
}

function FilterPopoverContents({
  orderedDimensions, activeCount, appliedChips, draggable, sensors, onDragEnd,
  onClearAll, onResetOrder, onSaveView, saveViewLabel, onClose, bodyMaxHeight,
}: {
  orderedDimensions: ReadonlyArray<FilterDimension>
  activeCount: number
  appliedChips: ReadonlyArray<AppliedChip>
  draggable: boolean
  sensors: ReturnType<typeof useSensors>
  onDragEnd: (e: DragEndEvent) => void
  onClearAll: () => void
  onResetOrder?: () => void
  onSaveView?: () => void
  saveViewLabel?: string
  onClose: () => void
  bodyMaxHeight: string
}) {
  return (
    <>
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
          onClick={onClose}
          className="h-6 w-6 inline-flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 rounded"
          aria-label="Close filters"
        >
          <X size={12} />
        </button>
      </div>

      {appliedChips.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap px-3 py-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-900/60">
          {appliedChips.map((chip) => (
            <span
              key={chip.key}
              className="inline-flex items-center h-6 text-xs rounded-full bg-blue-50 text-blue-900 border border-blue-200 dark:bg-blue-950/40 dark:text-blue-100 dark:border-blue-800 pl-2 pr-1 gap-1 max-w-[200px]"
            >
              <span className="font-medium text-blue-700 dark:text-blue-300">{chip.label}{chip.value ? ':' : ''}</span>
              {chip.value && <span className="truncate">{chip.value}</span>}
              <button
                type="button"
                onClick={chip.onRemove}
                className="hover:bg-blue-100 dark:hover:bg-blue-900/40 rounded-full p-0.5"
                aria-label={`Remove ${chip.label}${chip.value ? `: ${chip.value}` : ''} filter`}
              >
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className={`overflow-y-auto p-2 ${bodyMaxHeight}`}>
        {orderedDimensions.length === 0 ? (
          <div className="text-sm text-slate-500 dark:text-slate-400 italic px-2 py-4 text-center">
            No filters configured for this page.
          </div>
        ) : draggable ? (
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
            <SortableContext items={orderedDimensions.map((d) => d.key)} strategy={verticalListSortingStrategy}>
              {orderedDimensions.map((d) => (
                <SortableDimensionCard key={d.key} dimension={d} />
              ))}
            </SortableContext>
          </DndContext>
        ) : (
          orderedDimensions.map((d) => <DimensionCard key={d.key} dimension={d} />)
        )}
      </div>

      <div className="flex items-center justify-between gap-2 px-3 py-2 border-t border-slate-200 dark:border-slate-800 flex-wrap">
        <div className="flex items-center gap-3 text-sm">
          <button
            type="button"
            onClick={onClearAll}
            disabled={activeCount === 0}
            className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Clear all
          </button>
          {onResetOrder && (
            <>
              <span className="text-slate-300 dark:text-slate-600">·</span>
              <button
                type="button"
                onClick={onResetOrder}
                className="text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
                title="Restore the default filter order"
              >
                Reset order
              </button>
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {onSaveView && (
            <button
              type="button"
              onClick={() => { onSaveView(); onClose() }}
              disabled={activeCount === 0}
              className="h-7 px-3 text-sm border border-slate-200 dark:border-slate-700 rounded hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 disabled:opacity-40 disabled:cursor-not-allowed"
              title="Save the current filter state as a reusable view"
            >
              {saveViewLabel ?? 'Save as view'}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            className="h-7 px-3 text-sm bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded hover:bg-slate-800 dark:hover:bg-slate-200"
          >
            Done
          </button>
        </div>
      </div>
    </>
  )
}

function DimensionCard({ dimension, dragHandle }: { dimension: FilterDimension; dragHandle?: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false)
  const active = activeCountFor(dimension)

  return (
    <div className="border-b border-slate-100 dark:border-slate-800 last:border-0">
      <div className="w-full flex items-center gap-1 px-1 py-1 rounded group">
        {dragHandle}
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex-1 flex items-center justify-between gap-2 px-1 py-1 hover:bg-slate-50 dark:hover:bg-slate-800 rounded text-left"
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
      </div>
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

function SortableDimensionCard({ dimension }: { dimension: FilterDimension }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: dimension.key })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }
  return (
    <div ref={setNodeRef} style={style}>
      <DimensionCard
        dimension={dimension}
        dragHandle={
          <button
            type="button"
            {...attributes}
            {...listeners}
            aria-label={`Reorder ${dimension.label}`}
            className="h-6 w-5 inline-flex items-center justify-center text-slate-300 dark:text-slate-600 hover:text-slate-600 dark:hover:text-slate-300 cursor-grab active:cursor-grabbing rounded"
            title="Drag to reorder"
          >
            <GripVertical size={11} aria-hidden="true" />
          </button>
        }
      />
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
