'use client'

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { useToast } from '@/components/ui/Toast'
import type { EbayRow } from './EbayFlatFileClient'
import { deriveAxes, axisSynonymKey, shouldInitModal } from './variationValueOrder.pure'
import { AxisValueOrderEditor } from '@/components/ebay/AxisValueOrderEditor'

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
          <AxisValueOrderEditor
            axes={axes}
            axisSeq={axisSeq}
            axisOrder={axisOrder}
            onAxisSeqChange={setAxisSeq}
            onAxisOrderChange={handleAxisChange}
            interaction="drag"
            showPresetSorts
          />
        </div>
      )}
    </Modal>
  )
}
