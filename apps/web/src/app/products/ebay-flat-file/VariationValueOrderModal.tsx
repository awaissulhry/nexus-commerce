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

// ── Synonym groups (kept in sync with ebay-variation-push.service.ts) ─────
// Maps axis name aliases across languages to a stable key (__dim0__, __dim1__, …).
// Add new rows here as new axes are introduced; the modal will auto-detect them.
const AXIS_SYNONYM_GROUPS: ReadonlyArray<ReadonlyArray<string>> = [
  ['colore', 'color', 'colour', 'color name', 'color_name', 'couleur', 'farbe', 'kleur', 'colour name', 'colori'],
  ['taglia', 'size', 'size name', 'size_name', 'misura', 'größe', 'grosse', 'taille', 'maat', 'maten', 'koko'],
  ['stile', 'style', 'style name', 'style_name'],
  ['materiale', 'material', 'material name', 'material_name'],
  ['genere', 'gender', 'department', 'target audience', 'target_audience'],
]

function axisSynonymKey(name: string): string {
  const lk = name.toLowerCase().trim()
  for (let i = 0; i < AXIS_SYNONYM_GROUPS.length; i++) {
    if ((AXIS_SYNONYM_GROUPS[i] as string[]).includes(lk)) return `__dim${i}__`
  }
  return lk
}

// Clothing/shoe sizes in canonical small→large order (mirrors push service)
const STANDARD_SIZE_ORDER_MAP = new Map<string, number>(
  [
    'XXXS','XXS','XS','S','M','L','XL','XXL','XXXL','2XL','3XL','4XL','5XL','6XL','7XL',
    '30','32','34','36','38','40','42','44','46','48','50','52','54','56','58','60','62','64',
    '33','34','35','35.5','36','36.5','37','37.5','38','38.5','39','39.5',
    '40','40.5','41','41.5','42','42.5','43','43.5','44','44.5','45','45.5','46','46.5','47','48',
    '1','1.5','2','2.5','3','3.5','4','4.5','5','5.5','6','6.5','7','7.5',
    '8','8.5','9','9.5','10','10.5','11','11.5','12','12.5','13','14','15',
  ].map((v, i) => [v.toUpperCase(), i] as [string, number]),
)

function sortClothing(values: string[]): string[] {
  return [...values].sort((a, b) => {
    const ai = STANDARD_SIZE_ORDER_MAP.get(a.toUpperCase()) ?? 9999
    const bi = STANDARD_SIZE_ORDER_MAP.get(b.toUpperCase()) ?? 9999
    return ai !== bi ? ai - bi : a.localeCompare(b)
  })
}

// ── Axis detection ────────────────────────────────────────────────────────

interface AxisEntry {
  /** Stable storage key: __dim0__ / __dim1__ / … or lowercase name for custom axes */
  key: string
  /** Human label — first axis name found in actual row data for this dimension */
  displayName: string
  /** All distinct values collected from all synonym aliases */
  values: string[]
}

/**
 * Scan variant rows for aspect_* columns, collapse synonym aliases into one
 * entry per semantic dimension. Returns one AxisEntry per dimension that has
 * more than one distinct value (i.e. it is actually a variation axis).
 * Automatically detects any new axes — no hardcoding required.
 */
function deriveAxes(rows: EbayRow[]): AxisEntry[] {
  const variantRows = rows.filter((r) => r._isParent === false)

  // synonymKey → { firstNameFound, all values }
  const groups = new Map<string, { displayName: string; values: Set<string> }>()

  for (const row of variantRows) {
    for (const [k, v] of Object.entries(row)) {
      if (!k.startsWith('aspect_') || !v) continue
      // Convert column key back to axis name: aspect_Taglia → "Taglia"
      const rawName = k.slice('aspect_'.length).replace(/_/g, ' ').trim()
      if (!rawName) continue
      const val = String(v).trim()
      if (!val) continue

      const sk = axisSynonymKey(rawName)
      if (!groups.has(sk)) {
        groups.set(sk, { displayName: rawName, values: new Set() })
      }
      groups.get(sk)!.values.add(val)
    }
  }

  // Only keep dimensions with >1 distinct value (the true variation axes)
  const result: AxisEntry[] = []
  for (const [key, entry] of groups.entries()) {
    if (entry.values.size > 1) {
      result.push({ key, displayName: entry.displayName, values: [...entry.values] })
    }
  }
  return result
}

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
