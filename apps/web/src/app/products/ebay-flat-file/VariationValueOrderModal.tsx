'use client'

import { useState, useCallback, useMemo } from 'react'
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

// Clothing/shoe sizes in canonical small→large order
const STANDARD_SIZE_ORDER: string[] = [
  'XXXS','XXS','XS','S','M','L','XL','XXL','XXXL','2XL','3XL','4XL','5XL','6XL',
  '30','32','34','36','38','40','42','44','46','48','50','52','54','56','58','60','62','64',
  '33','34','35','35.5','36','36.5','37','37.5','38','38.5','39','39.5',
  '40','40.5','41','41.5','42','42.5','43','43.5','44','44.5','45','45.5','46','46.5','47','48',
]

function sortClothing(values: string[]): string[] {
  const order = new Map(STANDARD_SIZE_ORDER.map((v, i) => [v.toUpperCase(), i]))
  return [...values].sort((a, b) => {
    const ai = order.get(a.toUpperCase()) ?? 9999
    const bi = order.get(b.toUpperCase()) ?? 9999
    return ai !== bi ? ai - bi : a.localeCompare(b)
  })
}

// ── Sortable item ─────────────────────────────────────────────────────────

interface SortableItemProps {
  id: string
  label: string
}

function SortableItem({ id, label }: SortableItemProps) {
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
  axisName: string
  values: string[]
  onChange: (values: string[]) => void
}

function AxisPanel({ axisName, values, onChange }: AxisPanelProps) {
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
    <div className="mb-5">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
          {axisName}
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

/** Derive axes with >1 distinct value across variant rows */
function deriveAxes(rows: EbayRow[]): Record<string, string[]> {
  const variantRows = rows.filter((r) => r._isParent === false)
  const axisValues: Record<string, Set<string>> = {}

  for (const row of variantRows) {
    for (const [k, v] of Object.entries(row)) {
      if (!k.startsWith('aspect_') || !v) continue
      const axisName = k.slice('aspect_'.length).replace(/_/g, ' ')
      if (!axisName) continue
      const val = String(v).trim()
      if (!val) continue
      if (!axisValues[axisName]) axisValues[axisName] = new Set()
      axisValues[axisName].add(val)
    }
  }

  // Keep only axes with >1 distinct value (the variation axes)
  const result: Record<string, string[]> = {}
  for (const [axis, vals] of Object.entries(axisValues)) {
    if (vals.size > 1) result[axis] = [...vals]
  }
  return result
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

  const initialAxes = useMemo(() => deriveAxes(rows), [rows])
  const [axisOrder, setAxisOrder] = useState<Record<string, string[]>>(() => initialAxes)
  const [saving, setSaving] = useState(false)

  // Reset state when modal opens with fresh data
  const axes = useMemo(() => {
    if (!open) return {}
    return initialAxes
  }, [open, initialAxes])

  const handleAxisChange = useCallback((axisName: string, newValues: string[]) => {
    setAxisOrder((prev) => ({ ...prev, [axisName]: newValues }))
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

  const axisNames = Object.keys(axes)

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Variation value order"
      subtitle="Drag values to set the order they appear in the eBay listing. Changes apply on next push."
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
      {axisNames.length === 0 ? (
        <p className="text-sm text-slate-500 dark:text-slate-400 py-4 text-center">
          No variation axes detected in the current rows.
          <br />
          Make sure variant rows are loaded with aspect values filled.
        </p>
      ) : (
        <div className="py-2">
          {axisNames.map((axisName) => (
            <AxisPanel
              key={axisName}
              axisName={axisName}
              values={axisOrder[axisName] ?? axes[axisName] ?? []}
              onChange={(newValues) => handleAxisChange(axisName, newValues)}
            />
          ))}
        </div>
      )}
    </Modal>
  )
}
