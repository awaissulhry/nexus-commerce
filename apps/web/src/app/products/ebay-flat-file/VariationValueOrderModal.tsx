'use client'

import { useState, useCallback, useMemo, useEffect } from 'react'
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
import { GripVertical } from 'lucide-react'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { useToast } from '@/components/ui/Toast'
import type { EbayRow } from './EbayFlatFileClient'
import { sortClothing, deriveAxes } from './variationValueOrder.pure'

// ── Sortable item ─────────────────────────────────────────────────────────

function SortableItem({ id, label }: { id: string; label: string }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={[
        'flex items-center gap-2 px-2 py-1.5 rounded text-sm select-none border',
        isDragging
          ? 'bg-blue-50 border-blue-300 dark:bg-blue-900/20 dark:border-blue-600 shadow-lg z-50'
          : 'bg-white border-slate-200 dark:bg-slate-800 dark:border-slate-700',
      ].join(' ')}
    >
      <span
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing text-slate-400 hover:text-slate-600 dark:hover:text-slate-300 flex-shrink-0"
        aria-label={`Drag to reorder ${label}`}
      >
        <GripVertical size={14} />
      </span>
      <span className="truncate text-slate-800 dark:text-slate-200">{label}</span>
    </div>
  )
}

// ── Axis panel ────────────────────────────────────────────────────────────

interface AxisPanelProps {
  axisKey: string
  displayName: string
  values: string[]
  onChange: (values: string[]) => void
}

function AxisPanel({ displayName, values, onChange }: AxisPanelProps) {
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const oldIdx = values.indexOf(String(active.id))
    const newIdx = values.indexOf(String(over.id))
    if (oldIdx !== -1 && newIdx !== -1) onChange(arrayMove(values, oldIdx, newIdx))
  }, [values, onChange])

  return (
    <div className="mb-5 last:mb-0">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {displayName}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            className="text-[11px] px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            onClick={() => onChange(sortClothing(values))}
            title="Sort clothing/shoe sizes small → large"
          >
            Clothing ↕
          </button>
          <button
            type="button"
            className="text-[11px] px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            onClick={() => onChange([...values].sort((a, b) => a.localeCompare(b)))}
          >
            A→Z
          </button>
          <button
            type="button"
            className="text-[11px] px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            onClick={() => onChange([...values].sort((a, b) => b.localeCompare(a)))}
          >
            Z→A
          </button>
          <button
            type="button"
            className="text-[11px] px-2 py-0.5 rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            onClick={() => onChange([...values].reverse())}
          >
            Reverse
          </button>
        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={values} strategy={verticalListSortingStrategy}>
          <div className="flex flex-col gap-1">
            {values.map((v) => (
              <SortableItem key={v} id={v} label={v} />
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}

// ── Main modal ────────────────────────────────────────────────────────────

export interface VariationValueOrderModalProps {
  open: boolean
  onClose: () => void
  rows: EbayRow[]
  parentProductId: string | null
  marketplace: string
  onSaved?: () => void
}

export function VariationValueOrderModal({
  open,
  onClose,
  rows,
  parentProductId,
  marketplace,
  onSaved,
}: VariationValueOrderModalProps) {
  const { toast } = useToast()
  const BACKEND = getBackendUrl()

  // Derived from current rows — one entry per semantic dimension, synonyms collapsed
  const axes = useMemo(() => deriveAxes(rows), [rows])

  // axisOrder keyed by axis.key (__dim0__ / __dim1__ / raw-lowercase for custom axes)
  const [axisOrder, setAxisOrder] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(axes.map((a) => [a.key, a.values])),
  )
  const [saving, setSaving] = useState(false)

  // Re-initialise when modal reopens (fresh rows may have changed)
  useEffect(() => {
    if (open) {
      setAxisOrder(Object.fromEntries(axes.map((a) => [a.key, a.values])))
    }
  }, [open, axes])

  const handleAxisChange = useCallback((key: string, newValues: string[]) => {
    setAxisOrder((prev) => ({ ...prev, [key]: newValues }))
  }, [])

  const handleSave = useCallback(async () => {
    if (!parentProductId) return
    setSaving(true)
    try {
      const res = await fetch(`${BACKEND}/api/ebay/cockpit/variation-matrix`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parentProductId,
          marketplace,
          axisValueOrder: axisOrder,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      toast.success('Value order saved — will take effect on next push')
      onSaved?.()
      onClose()
    } catch (e) {
      toast.error(`Failed to save: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }, [parentProductId, marketplace, axisOrder, BACKEND, toast, onSaved, onClose])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Variation value order"
      subtitle="Drag values to set the order they appear on the eBay listing. Applies on next push."
      size="md"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void handleSave()} disabled={saving || !parentProductId}>
            {saving ? 'Saving…' : 'Save order'}
          </Button>
        </div>
      }
    >
      {axes.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400 py-4 text-center">
          No variation axes detected.
          <br />
          Load the family rows and make sure aspect values are filled in.
        </p>
      ) : (
        <div className="py-2">
          {axes.map((axis) => (
            <AxisPanel
              key={axis.key}
              axisKey={axis.key}
              displayName={axis.displayName}
              values={axisOrder[axis.key] ?? axis.values}
              onChange={(newValues) => handleAxisChange(axis.key, newValues)}
            />
          ))}
        </div>
      )}
    </Modal>
  )
}
