'use client'

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
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
import { sortClothing, deriveAxes, axisSynonymKey, shouldInitModal } from './variationValueOrder.pure'
import { ChevronUp, ChevronDown } from 'lucide-react'

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

  // FFP.8 — axis ORDER: which dropdown the buyer picks first on the listing.
  // Persists as _variationAxes (same key the cockpit's Variations card writes);
  // the push now orders variesBy.specifications by it.
  const [axisSeq, setAxisSeq] = useState<string[]>([])

  // Init ONCE per open cycle (closed→open transition). The parent grid
  // re-renders frequently while the modal is open (draft autosave ~400ms,
  // toasts, SSE refreshes) with a NEW rows identity each time → `axes` gets a
  // new identity → without this guard the effect re-ran MID-OPEN, resetting
  // axisOrder/axisSeq to derived and discarding the operator's un-saved
  // reordering (which Save then persisted). The open-time snapshot is correct;
  // reopening refreshes. Decision extracted to shouldInitModal (pure, tested).
  const wasOpenRef = useRef(false)
  useEffect(() => {
    if (!open) {
      wasOpenRef.current = false // closed — next open re-initializes
      return
    }
    if (shouldInitModal(open, wasOpenRef.current)) {
      wasOpenRef.current = true
      // Base: derived value order per axis (stands if the fetch fails).
      setAxisOrder(Object.fromEntries(axes.map((a) => [a.key, a.values])))
      const derived = axes.map((a) => a.displayName)
      setAxisSeq(derived)
      // EFX D1/D9 — seed BOTH the axis order (pickedAxes) and the per-axis value
      // order (axisValueOrder) from the stored per-market config so the modal
      // reloads exactly what was saved / what the push will use. Best-effort —
      // the derived order stands if the fetch fails. D9: NO >1-axis gate —
      // single-axis families persist + reload their config too.
      // Uses GET /variation-cells (the /variation-matrix GET was never
      // registered — only its PATCH is — so the old fetch 404'd silently).
      if (parentProductId) {
        void fetch(`${BACKEND}/api/ebay/cockpit/variation-cells?parentProductId=${encodeURIComponent(parentProductId)}&marketplace=${encodeURIComponent(marketplace)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((d: { pickedAxes?: string[]; axisValueOrder?: Record<string, string[]> } | null) => {
            if (!d) return
            // Axis ORDER — order the derived axes by the stored pickedAxes.
            const stored = d.pickedAxes
            if (stored?.length) {
              const rank = new Map(stored.map((a, i) => [axisSynonymKey(a), i]))
              setAxisSeq([...derived].sort(
                (a, b) => (rank.get(axisSynonymKey(a)) ?? Number.MAX_SAFE_INTEGER) - (rank.get(axisSynonymKey(b)) ?? Number.MAX_SAFE_INTEGER),
              ))
            }
            // VALUE order — within each axis, apply the stored value order first
            // (keyed by axis.key: __dim0__/__dim1__/lowercase-custom — the SAME
            // keys the modal saves with), appending any new/unknown values after
            // in derived order. Stable sort keeps derived order among unknowns.
            const storedValues = d.axisValueOrder
            if (storedValues && Object.keys(storedValues).length) {
              setAxisOrder((prev) => {
                const next: Record<string, string[]> = { ...prev }
                for (const a of axes) {
                  const order = storedValues[a.key]
                  if (!order?.length) continue
                  const rank = new Map(order.map((v, i) => [v.toLowerCase(), i]))
                  next[a.key] = [...(prev[a.key] ?? a.values)].sort((x, y) => {
                    const xi = rank.get(x.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
                    const yi = rank.get(y.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
                    return xi - yi
                  })
                }
                return next
              })
            }
          })
          .catch(() => {})
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, axes])

  const moveAxis = useCallback((index: number, delta: -1 | 1) => {
    setAxisSeq((prev) => {
      const next = [...prev]
      const j = index + delta
      if (j < 0 || j >= next.length) return prev
      ;[next[index], next[j]] = [next[j], next[index]]
      return next
    })
  }, [])

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
          // FFP.8 — the axis sequence itself (buyer-facing dropdown order).
          // EFX D9 — persist for single-axis families too (was gated at >1,
          // which dropped single-axis configs). Only the empty case is skipped
          // so we never clobber stored axes with [].
          ...(axisSeq.length > 0 ? { pickedAxes: axisSeq } : {}),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as { error?: string }
        throw new Error(err.error ?? `HTTP ${res.status}`)
      }
      toast.success('Variation order saved — applies on next push')
      onSaved?.()
      onClose()
    } catch (e) {
      toast.error(`Failed to save: ${e instanceof Error ? e.message : String(e)}`)
    } finally {
      setSaving(false)
    }
  }, [parentProductId, marketplace, axisOrder, axisSeq, BACKEND, toast, onSaved, onClose])

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Variation order"
      subtitle="Order the axes (which dropdown comes first) and the values within each. Applies on next push."
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
          {/* FFP.8 — axis order (buyer picks in this order on the listing) */}
          {axisSeq.length > 1 && (
            <div className="mb-3 rounded-lg border border-slate-200 dark:border-slate-700 p-2.5">
              <div className="text-[11px] font-semibold text-slate-600 dark:text-slate-300 mb-1.5">
                Axis order — buyers pick in this order on eBay
              </div>
              <ul className="space-y-1">
                {axisSeq.map((name, i) => (
                  <li key={name} className="flex items-center gap-2 text-sm text-slate-700 dark:text-slate-200">
                    <span className="w-4 text-[11px] tabular-nums text-slate-400">{i + 1}.</span>
                    <span className="flex-1">{name}</span>
                    <button
                      type="button"
                      disabled={i === 0}
                      onClick={() => moveAxis(i, -1)}
                      className="p-0.5 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30"
                      aria-label={`Move ${name} up`}
                    >
                      <ChevronUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      disabled={i === axisSeq.length - 1}
                      onClick={() => moveAxis(i, 1)}
                      className="p-0.5 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-30"
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
