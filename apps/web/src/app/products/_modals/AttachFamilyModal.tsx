'use client'

/**
 * W2.13 — bulk attach-family modal.
 *
 * Operator selects N products → BulkActionBar's "Family" button →
 * this modal. Pick a target family from the dropdown (or "Detach"
 * to clear familyId), submit. Hits POST /api/products/bulk-attach-
 * family which writes one AuditLog row per changed product and
 * runs in a single $transaction (W2.8).
 *
 * Lazy-loaded via next/dynamic from BulkActionBar so the family
 * dropdown chunk only ships when the operator opens the modal.
 *
 * What's intentionally *not* here:
 *   - Family search/filter — the dropdown handles "type to filter"
 *     natively. We don't expect more than ~50 families in any
 *     realistic catalog (Akeneo's typical is 20-80).
 *   - Per-product diff preview ("3 will move from A to B, 2 will
 *     gain a family"). The response surfaces requested/updated/
 *     changed/noOp counts post-submit and the toast has it all.
 *     Pre-submit overlay is overkill for a 280-product catalog.
 */

import { useEffect, useState } from 'react'
import { Folder, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

interface FamilyOption {
  id: string
  code: string
  label: string
}

interface AttachFamilyModalProps {
  productIds: string[]
  onClose: () => void
  onComplete: () => void
}

export default function AttachFamilyModal({
  productIds,
  onClose,
  onComplete,
}: AttachFamilyModalProps) {
  const [families, setFamilies] = useState<FamilyOption[] | null>(null)
  const [target, setTarget] = useState<string>('') // family id, or '' for detach
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { toast } = useToast()

  useEffect(() => {
    let cancelled = false
    fetch(`${getBackendUrl()}/api/families`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        if (cancelled) return
        const list: FamilyOption[] = (data.families ?? []).map((f: any) => ({
          id: f.id,
          code: f.code,
          label: f.label,
        }))
        list.sort((a, b) => a.label.localeCompare(b.label))
        setFamilies(list)
        if (list[0]) setTarget(list[0].id)
      })
      .catch((e) => !cancelled && setErr(e?.message ?? String(e)))
    return () => {
      cancelled = true
    }
  }, [])

  const submit = async (mode: 'attach' | 'detach') => {
    setErr(null)
    setSubmitting(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/bulk-attach-family`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            productIds,
            familyId: mode === 'detach' ? null : target,
          }),
        },
      )
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error ?? `HTTP ${res.status}`)
      }
      const r = (await res.json()) as {
        updated: number
        changed: number
        noOp: number
        skipped: number
      }
      const familyName =
        mode === 'detach'
          ? '(no family)'
          : (families?.find((f) => f.id === target)?.label ?? 'family')
      toast.success(
        r.changed === r.updated
          ? `Attached ${r.changed} product${r.changed === 1 ? '' : 's'} to ${familyName}`
          : `${r.changed} changed · ${r.noOp} already had it · ${r.skipped} skipped`,
      )
      // Refresh the grid + any open drawer.
      emitInvalidation({
        type: 'product.updated',
        meta: { productIds, source: 'bulk-attach-family' },
      })
      onComplete()
    } catch (e: any) {
      setErr(e?.message ?? String(e))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      dismissOnBackdrop={!submitting}
      dismissOnEscape={!submitting}
      size="lg"
      title={
        <span className="inline-flex items-center gap-1.5">
          <Folder size={14} /> Attach family to {productIds.length} product
          {productIds.length === 1 ? '' : 's'}
        </span>
      }
      description="Categorise selected products under a PIM family. The family declares which attributes apply (Akeneo-style). Detaching reverts to the legacy categoryAttributes JSON path; stored attribute values are preserved."
    >
      <div className="p-5 space-y-4">
        {families === null ? (
          <div className="inline-flex items-center gap-2 text-base text-slate-500 dark:text-slate-400">
            <Loader2 size={14} className="animate-spin" /> Loading families…
          </div>
        ) : families.length === 0 ? (
          <div className="border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 rounded-md px-3 py-2 text-base text-amber-800 dark:text-amber-300">
            No families exist yet. Create one under{' '}
            <a
              href="/settings/pim/families"
              className="underline font-medium"
            >
              Settings → PIM → Families
            </a>{' '}
            first.
          </div>
        ) : (
          <div className="space-y-1">
            <label className="text-sm uppercase tracking-wider font-semibold text-slate-500 dark:text-slate-400 block">
              Family
            </label>
            <select
              value={target}
              onChange={(e) => setTarget(e.target.value)}
              autoFocus
              className="w-full h-9 px-2 text-base border border-slate-200 dark:border-slate-800 rounded dark:bg-slate-900 dark:text-slate-100"
            >
              {families.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label} ({f.code})
                </option>
              ))}
            </select>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Soft-deleted products in the selection are silently skipped.
              Per-product AuditLog row written for each change.
            </p>
          </div>
        )}
        {err && (
          <div className="border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/40 rounded-md px-3 py-2 text-base text-rose-700 dark:text-rose-300">
            {err}
          </div>
        )}
      </div>
      <ModalFooter className="!justify-between">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => submit('detach')}
          disabled={submitting}
          title="Clear familyId on all selected products (revert to legacy categoryAttributes path)"
          className="!text-rose-600 hover:!bg-rose-50 dark:hover:!bg-rose-950/40"
        >
          Detach family
        </Button>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => submit('attach')}
            disabled={submitting || !target || !families || families.length === 0}
            loading={submitting}
          >
            Attach
          </Button>
        </div>
      </ModalFooter>
    </Modal>
  )
}
