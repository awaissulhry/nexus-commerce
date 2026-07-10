'use client'

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { Modal } from '@/design-system/components/Modal'
import { Button } from '@/components/ui/Button'
import { getBackendUrl } from '@/lib/backend-url'
import { useToast } from '@/components/ui/Toast'
import type { EbayRow } from './EbayFlatFileClient'
import { deriveAxes, shouldInitModal } from './variationValueOrder.pure'
import { intersectPickedWithResolved, type ResolvedAxis } from './resolvedAxes.pure'
import { AxisValueOrderEditor, type AxisEntry } from '@/components/ebay/AxisValueOrderEditor'

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

  // EAC Layer A — prefer the server's theme-authoritative axes (declared-order,
  // synonym+fingerprint-deduped, ghosts like "Team Name" already removed) when
  // the variation-cells fetch returns them; fall back to the local
  // deriveAxes(rows) so an OLD endpoint (no resolvedAxes) still works exactly as
  // before. resolvedAxes lands via the same fetch below.
  const derivedAxes = useMemo(() => deriveAxes(rows), [rows])
  const [resolvedAxes, setResolvedAxes] = useState<ResolvedAxis[] | null>(null)
  const [axisWarnings, setAxisWarnings] = useState<string[]>([])
  const axes = useMemo<AxisEntry[]>(
    () =>
      resolvedAxes && resolvedAxes.length
        ? resolvedAxes.map((a) => ({ key: a.key, displayName: a.name, values: a.values }))
        : derivedAxes,
    [resolvedAxes, derivedAxes],
  )

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
      // Base: LOCALLY-derived value order per axis (stands if the fetch fails or
      // the endpoint is old). resolvedAxes is reset so `axes` falls back to
      // derivedAxes until (and unless) the fetch returns the authoritative list.
      setResolvedAxes(null)
      setAxisWarnings([])
      setAxisOrder(Object.fromEntries(derivedAxes.map((a) => [a.key, a.values])))
      setAxisSeq(derivedAxes.map((a) => a.displayName))
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
          .then((d: {
            pickedAxes?: string[]
            axisValueOrder?: Record<string, string[]>
            resolvedAxes?: ResolvedAxis[]
            resolvedAxisWarnings?: string[]
          } | null) => {
            if (!d) return
            // EAC Layer A — prefer the authoritative axes for BOTH the axis list
            // and each axis's value list; fall back to the locally-derived axes
            // when the endpoint omits them (backward-safe). This is the ONLY
            // place `axes` swaps to resolved, so the init guard can't re-run it.
            const resolved = Array.isArray(d.resolvedAxes) ? d.resolvedAxes : []
            const eff: AxisEntry[] = resolved.length
              ? resolved.map((a) => ({ key: a.key, displayName: a.name, values: a.values }))
              : derivedAxes
            if (resolved.length) setResolvedAxes(resolved)
            setAxisWarnings(Array.isArray(d.resolvedAxisWarnings) ? d.resolvedAxisWarnings : [])

            // Axis ORDER — seed pickedAxes but INTERSECT with the authoritative
            // axes: a ghost still lingering in pickedAxes (e.g. "Team Name") is
            // dropped because it has no resolved match, so it can't re-appear.
            setAxisSeq(intersectPickedWithResolved(d.pickedAxes ?? [], resolved.length ? resolved : eff.map((a) => ({ name: a.displayName, key: a.key, values: a.values }))))

            // VALUE order — start from eff's value lists (authoritative when
            // present), then apply the stored per-axis order (keyed by axis.key:
            // __dim0__/__dim1__/lowercase-custom — the SAME keys the modal saves
            // with), appending any new/unknown values after in eff order.
            const base = Object.fromEntries(eff.map((a) => [a.key, a.values])) as Record<string, string[]>
            const storedValues = d.axisValueOrder
            if (storedValues && Object.keys(storedValues).length) {
              for (const a of eff) {
                const order = storedValues[a.key]
                if (!order?.length) continue
                const rank = new Map(order.map((v, i) => [v.toLowerCase(), i]))
                base[a.key] = [...(base[a.key] ?? a.values)].sort((x, y) => {
                  const xi = rank.get(x.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
                  const yi = rank.get(y.toLowerCase()) ?? Number.MAX_SAFE_INTEGER
                  return xi - yi
                })
              }
            }
            setAxisOrder(base)
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
          {axisWarnings.length > 0 && (
            <div className="mb-3 rounded-md border border-amber-200 dark:border-amber-900 bg-amber-50/60 dark:bg-amber-950/30 px-3 py-2 text-[11px] text-amber-800 dark:text-amber-300">
              <ul className="space-y-0.5">
                {axisWarnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            </div>
          )}
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
