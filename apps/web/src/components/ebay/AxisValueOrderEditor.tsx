'use client'

// EFX P3 — the ONE eBay variation ordering surface.
//
// A purely-controlled editor for:
//   1. axis ORDER  — which variation dropdown a buyer picks first on eBay
//      (numbered rows + up/down chevrons).
//   2. per-axis VALUE order — the order values appear within each axis
//      (dnd-kit drag OR up/down arrows) + optional preset sorts
//      (Clothing / A→Z / Z→A / Reverse).
//
// It owns NO state, does NO fetching, and does NO saving — parents pass the
// current axes/order and receive change callbacks. This lets both the flat-file
// VariationValueOrderModal (interaction='drag', presets on) and the cockpit
// VariationsMatrixCard (interaction='arrows', renames injected) share one
// implementation so the two surfaces can never drift.
//
// `AxisEntry.key` is treated as an OPAQUE identifier for value-order storage:
//   • the modal keys it by axisSynonymKey (__dim0__/__dim1__/lowercase-custom)
//   • the card keys it by axisSynonymKey too, mapping back to raw names for the
//     rename slots via renderAxisExtra / renderValueExtra.

import { useCallback, type ReactNode } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
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
import { GripVertical, ChevronUp, ChevronDown } from 'lucide-react'
import { sortClothing } from '@/app/products/ebay-flat-file/variationValueOrder.pure'

export interface AxisEntry {
  /** Opaque stable storage key (synonym key or raw name — parent's choice). */
  key: string
  /** Human label shown as the panel heading. */
  displayName: string
  /** Distinct values for this axis (the fallback order when axisOrder has none). */
  values: string[]
}

export interface AxisValueOrderEditorProps {
  /** Axes to render value panels for (one panel each). */
  axes: AxisEntry[]
  /** Ordered axis-identifier strings for the "buyer picks in this order" list. */
  axisSeq: string[]
  /** Per-axis value order, keyed by AxisEntry.key. Missing → axis.values. */
  axisOrder: Record<string, string[]>
  /** Reorder of the axis sequence. */
  onAxisSeqChange: (seq: string[]) => void
  /** New value order for one axis (full array; key = AxisEntry.key). */
  onAxisOrderChange: (key: string, values: string[]) => void
  /** 'drag' = dnd-kit grip rows; 'arrows' = up/down button rows. */
  interaction: 'drag' | 'arrows'
  /** Show the Clothing / A→Z / Z→A / Reverse preset buttons. */
  showPresetSorts?: boolean
  /** Extra content beside an axis's heading (e.g. an eBay-only rename input). */
  renderAxisExtra?: (axisKey: string) => ReactNode
  /** Extra content in a value row (e.g. an eBay-only value rename input). */
  renderValueExtra?: (axisKey: string, value: string) => ReactNode
}

// ── Draggable value row (interaction='drag') ────────────────────────────────

function SortableValueRow({
  id,
  children,
}: {
  id: string
  children: ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={[
        'flex items-center gap-2 px-2 py-1.5 rounded text-sm select-none border',
        isDragging
          ? 'bg-blue-50 border-blue-300 dark:bg-blue-900/20 dark:border-blue-600 shadow-lg z-50'
          : 'bg-white border-default dark:bg-slate-800 dark:border-slate-700',
      ].join(' ')}
    >
      <span
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-tertiary hover:text-slate-600 dark:hover:text-slate-300 flex-shrink-0"
        aria-label={`Drag to reorder ${id}`}
      >
        <GripVertical size={14} />
      </span>
      {children}
    </div>
  )
}

// ── Per-axis value panel ────────────────────────────────────────────────────

function AxisPanel({
  axis,
  values,
  interaction,
  showPresetSorts,
  onChange,
  renderAxisExtra,
  renderValueExtra,
}: {
  axis: AxisEntry
  values: string[]
  interaction: 'drag' | 'arrows'
  showPresetSorts: boolean
  onChange: (values: string[]) => void
  renderAxisExtra?: (axisKey: string) => ReactNode
  renderValueExtra?: (axisKey: string, value: string) => ReactNode
}) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const oldIdx = values.indexOf(String(active.id))
      const newIdx = values.indexOf(String(over.id))
      if (oldIdx !== -1 && newIdx !== -1) onChange(arrayMove(values, oldIdx, newIdx))
    },
    [values, onChange],
  )

  const moveValue = useCallback(
    (index: number, delta: -1 | 1) => {
      const j = index + delta
      if (j < 0 || j >= values.length) return
      onChange(arrayMove(values, index, j))
    },
    [values, onChange],
  )

  // Value-row inner content: the rename slot when provided (its placeholder
  // carries the raw value), else a static label. Keeps the card's rename-only
  // row and the modal's label row both exact.
  const valueContent = (value: string): ReactNode =>
    renderValueExtra ? (
      renderValueExtra(axis.key, value)
    ) : (
      <span className="truncate text-slate-800 dark:text-slate-200">{value}</span>
    )

  return (
    <div className="mb-5 last:mb-0">
      <div className="flex items-center justify-between mb-2 gap-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400 flex items-center gap-1.5 min-w-0">
          <span className="truncate">{axis.displayName}</span>
          {renderAxisExtra?.(axis.key)}
        </span>
        {showPresetSorts && (
          <div className="flex gap-1 flex-shrink-0">
            <button
              type="button"
              className="text-[11px] px-2 py-0.5 rounded border border-default dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              onClick={() => onChange(sortClothing(values))}
              title="Sort clothing/shoe sizes small → large"
            >
              Clothing ↕
            </button>
            <button
              type="button"
              className="text-[11px] px-2 py-0.5 rounded border border-default dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              onClick={() => onChange([...values].sort((a, b) => a.localeCompare(b)))}
            >
              A→Z
            </button>
            <button
              type="button"
              className="text-[11px] px-2 py-0.5 rounded border border-default dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              onClick={() => onChange([...values].sort((a, b) => b.localeCompare(a)))}
            >
              Z→A
            </button>
            <button
              type="button"
              className="text-[11px] px-2 py-0.5 rounded border border-default dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
              onClick={() => onChange([...values].reverse())}
            >
              Reverse
            </button>
          </div>
        )}
      </div>

      {interaction === 'drag' ? (
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={values} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-1">
              {values.map((v) => (
                <SortableValueRow key={v} id={v}>
                  {valueContent(v)}
                </SortableValueRow>
              ))}
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className="space-y-1">
          {values.map((v, i) => (
            <div
              key={v}
              className="flex items-center gap-1 px-2 py-1 text-xs rounded bg-slate-50 dark:bg-slate-800/60"
            >
              <button
                type="button"
                onClick={() => moveValue(i, -1)}
                disabled={i === 0}
                className="p-0.5 text-tertiary hover:text-slate-800 dark:hover:text-slate-200 disabled:opacity-30"
                aria-label={`Move ${v} up`}
              >
                <ChevronUp className="w-3 h-3" />
              </button>
              <button
                type="button"
                onClick={() => moveValue(i, +1)}
                disabled={i === values.length - 1}
                className="p-0.5 text-tertiary hover:text-slate-800 dark:hover:text-slate-200 disabled:opacity-30"
                aria-label={`Move ${v} down`}
              >
                <ChevronDown className="w-3 h-3" />
              </button>
              {valueContent(v)}
              <span className="text-[10px] text-tertiary ml-auto flex-shrink-0">{i + 1}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Main editor ─────────────────────────────────────────────────────────────

export function AxisValueOrderEditor({
  axes,
  axisSeq,
  axisOrder,
  onAxisSeqChange,
  onAxisOrderChange,
  interaction,
  showPresetSorts = false,
  renderAxisExtra,
  renderValueExtra,
}: AxisValueOrderEditorProps) {
  const moveAxis = useCallback(
    (index: number, delta: -1 | 1) => {
      const j = index + delta
      if (j < 0 || j >= axisSeq.length) return
      const next = [...axisSeq]
      ;[next[index], next[j]] = [next[j], next[index]]
      onAxisSeqChange(next)
    },
    [axisSeq, onAxisSeqChange],
  )

  return (
    <div>
      {/* Axis order — buyers pick in this order on eBay */}
      {axisSeq.length > 1 && (
        <div className="mb-3 rounded-lg border border-default dark:border-slate-700 p-2.5">
          <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
            Axis order — buyers pick in this order on eBay
          </div>
          <ul className="space-y-1">
            {axisSeq.map((name, i) => (
              <li key={name} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                <span className="w-4 text-[11px] tabular-nums text-tertiary">{i + 1}.</span>
                <span className="flex-1 truncate">{name}</span>
                <button
                  type="button"
                  disabled={i === 0}
                  onClick={() => moveAxis(i, -1)}
                  className="p-0.5 rounded text-tertiary hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30"
                  aria-label={`Move ${name} up`}
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  disabled={i === axisSeq.length - 1}
                  onClick={() => moveAxis(i, 1)}
                  className="p-0.5 rounded text-tertiary hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30"
                  aria-label={`Move ${name} down`}
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {axes.map((axis) => (
        <AxisPanel
          key={axis.key}
          axis={axis}
          values={axisOrder[axis.key] ?? axis.values}
          interaction={interaction}
          showPresetSorts={showPresetSorts}
          onChange={(newValues) => onAxisOrderChange(axis.key, newValues)}
          renderAxisExtra={renderAxisExtra}
          renderValueExtra={renderValueExtra}
        />
      ))}
    </div>
  )
}
