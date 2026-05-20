'use client'

import { useRef, useState } from 'react'
import { Columns, GripVertical, Plus, X } from 'lucide-react'
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

export interface ColumnSpec<K extends string = string> {
  key: K
  label: string
  /** Pinned column; toggle off button is hidden and reset can't remove it. */
  alwaysOn?: boolean
}

export interface ColumnPickerProps<K extends string = string> {
  /** Catalog of every column key + label that could be shown. */
  allColumns: ReadonlyArray<ColumnSpec<K>>
  /** Current visible-column order. */
  visible: ReadonlyArray<K>
  onChange: (next: K[]) => void
  /** "Reset to default" button writes this back. */
  defaultVisible: ReadonlyArray<K>
  /** Button label override (e.g. 'Columns (8)'). Defaults to 'Columns'. */
  buttonLabel?: string
}

/**
 * Visible-column picker with drag-to-reorder. Extracted from
 * /fulfillment/stock so every grid workspace can adopt it without
 * duplicating the dnd-kit plumbing.
 *
 * Visible columns appear at the top in their current order (drag to
 * reorder); hidden columns sit below and toggle in via click. A
 * "Reset to default" button restores the page's canonical order.
 */
export function ColumnPicker<K extends string = string>({
  allColumns, visible, onChange, defaultVisible, buttonLabel,
}: ColumnPickerProps<K>) {
  const [open, setOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement>(null)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const visibleArr = visible as K[]
  const hidden = allColumns.filter((c) => !visibleArr.includes(c.key))

  const onDragEnd = (e: DragEndEvent) => {
    const { active, over } = e
    if (!over || active.id === over.id) return
    const oldIdx = visibleArr.indexOf(active.id as K)
    const newIdx = visibleArr.indexOf(over.id as K)
    if (oldIdx === -1 || newIdx === -1) return
    onChange(arrayMove(visibleArr, oldIdx, newIdx))
  }

  const toggleHidden = (key: K) => onChange([...visibleArr, key])
  const removeVisible = (key: K) => {
    const meta = allColumns.find((c) => c.key === key)
    if (meta?.alwaysOn) return
    onChange(visibleArr.filter((k) => k !== key))
  }

  return (
    <div className="relative">
      <button
        ref={btnRef}
        onClick={() => setOpen((o) => !o)}
        className="h-8 px-2.5 text-sm inline-flex items-center gap-1.5 border border-slate-200 dark:border-slate-700 rounded-md hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-800 text-slate-600"
        title="Show / hide / reorder columns"
      >
        <Columns size={12} /> {buttonLabel ?? 'Columns'}
      </button>
      {open && (
        <AnchoredPopover
          anchorRef={btnRef}
          onClose={() => setOpen(false)}
          className="w-64 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 rounded-md shadow-lg p-2 text-base"
          ariaLabel="Columns"
        >
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold px-1.5 pb-1.5 inline-flex items-center gap-1">
              Visible
              <span className="text-slate-400 dark:text-slate-500 normal-case font-normal">· drag to reorder</span>
            </div>
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <SortableContext items={visibleArr} strategy={verticalListSortingStrategy}>
                <ul className="space-y-0.5">
                  {visibleArr.map((key) => {
                    const col = allColumns.find((c) => c.key === key)
                    if (!col) return null
                    return (
                      <SortableColumnRow
                        key={key}
                        colKey={key}
                        label={col.label}
                        alwaysOn={!!col.alwaysOn}
                        onRemove={() => removeVisible(key)}
                      />
                    )
                  })}
                </ul>
              </SortableContext>
            </DndContext>

            {hidden.length > 0 && (
              <>
                <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold px-1.5 pt-2 pb-1.5 mt-1.5 border-t border-slate-100 dark:border-slate-800">
                  Hidden
                </div>
                <ul className="space-y-0.5">
                  {hidden.map((col) => (
                    <li key={col.key}>
                      <button
                        onClick={() => toggleHidden(col.key)}
                        className="w-full flex items-center justify-between gap-2 px-1.5 py-1 rounded hover:bg-slate-50 dark:hover:bg-slate-800 text-left text-slate-600 dark:text-slate-400"
                      >
                        <span className="inline-flex items-center gap-2">
                          <Plus size={11} aria-hidden="true" /> {col.label}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </>
            )}

            <button
              onClick={() => onChange([...defaultVisible])}
              className="w-full mt-1.5 pt-1.5 border-t border-slate-100 dark:border-slate-800 text-sm text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 text-left px-1.5 py-1"
            >
              Reset to default
            </button>
        </AnchoredPopover>
      )}
    </div>
  )
}

function SortableColumnRow<K extends string>({
  colKey, label, alwaysOn, onRemove,
}: { colKey: K; label: string; alwaysOn: boolean; onRemove: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: colKey })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  }
  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-1 px-1 py-1 rounded hover:bg-slate-50 dark:hover:bg-slate-800 group"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${label}`}
        className="h-6 w-6 inline-flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-300 cursor-grab active:cursor-grabbing rounded"
      >
        <GripVertical size={12} aria-hidden="true" />
      </button>
      <span className="flex-1 text-slate-700 dark:text-slate-300">{label}</span>
      {alwaysOn ? (
        <span className="text-xs text-slate-400 dark:text-slate-500">always on</span>
      ) : (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Hide ${label}`}
          className="h-6 w-6 inline-flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-rose-700 dark:hover:text-rose-300 opacity-0 group-hover:opacity-100 rounded"
        >
          <X size={12} aria-hidden="true" />
        </button>
      )}
    </li>
  )
}
