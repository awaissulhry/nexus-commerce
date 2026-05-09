'use client'

/**
 * F.3.b — bulk-schedule modal.
 *
 * Operator selects N products → BulkActionBar's "Schedule" button →
 * this modal. Pick a kind (STATUS or PRICE), the payload, and a
 * future timestamp. We submit one POST per selected id to
 * /api/products/:id/scheduled-changes; per-product errors surface
 * inline at the bottom.
 *
 * The cron worker (`scheduled-changes.cron.ts`, every 60s) picks up
 * PENDING rows and applies them via the same master*Service path
 * as a live PATCH.
 *
 * Lazy-loaded via next/dynamic from BulkActionBar so the heavy
 * datetime-picker chunk only ships when the operator opens it.
 */

import { useMemo, useState } from 'react'
import { Calendar, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Modal, ModalFooter } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

interface ScheduleChangeModalProps {
  productIds: string[]
  onClose: () => void
  onComplete: () => void
}

type Kind = 'STATUS' | 'PRICE'

interface SubmitError {
  productId: string
  error: string
}

/**
 * Format a Date as the local-time string the <input type="datetime-local">
 * element expects: "YYYY-MM-DDTHH:MM". Avoids the timezone slop that
 * comes from .toISOString() (which is UTC).
 */
function toDateTimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

export default function ScheduleChangeModal({
  productIds,
  onClose,
  onComplete,
}: ScheduleChangeModalProps) {
  const { toast } = useToast()
  const [kind, setKind] = useState<Kind>('STATUS')
  const [status, setStatus] = useState<'ACTIVE' | 'DRAFT' | 'INACTIVE'>(
    'ACTIVE',
  )
  const [priceMode, setPriceMode] = useState<'absolute' | 'percent'>('percent')
  const [priceAbsolute, setPriceAbsolute] = useState<string>('')
  const [pricePercent, setPricePercent] = useState<string>('-15')
  const tomorrow9am = useMemo(() => {
    const d = new Date()
    d.setDate(d.getDate() + 1)
    d.setHours(9, 0, 0, 0)
    return d
  }, [])
  const [scheduledFor, setScheduledFor] = useState<string>(
    toDateTimeLocal(tomorrow9am),
  )

  const [submitting, setSubmitting] = useState(false)
  const [errors, setErrors] = useState<SubmitError[]>([])

  const submit = async () => {
    setErrors([])
    // Build payload + validate before firing N requests.
    let payload: Record<string, unknown>
    if (kind === 'STATUS') {
      payload = { status }
    } else {
      if (priceMode === 'absolute') {
        const n = Number(priceAbsolute)
        if (!Number.isFinite(n) || n < 0) {
          toast.error('Enter a valid price ≥ 0')
          return
        }
        payload = { basePrice: n }
      } else {
        const n = Number(pricePercent)
        if (!Number.isFinite(n)) {
          toast.error('Enter a valid percent (e.g. -15 or 10)')
          return
        }
        payload = { adjustPercent: n }
      }
    }
    const when = new Date(scheduledFor)
    if (Number.isNaN(when.getTime())) {
      toast.error('Pick a valid date/time')
      return
    }
    if (when.getTime() <= Date.now()) {
      toast.error('Schedule a future timestamp (or apply now via Activate/Draft/Inactive)')
      return
    }

    setSubmitting(true)
    const collected: SubmitError[] = []
    let scheduled = 0
    for (const productId of productIds) {
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/products/${productId}/scheduled-changes`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              kind,
              payload,
              scheduledFor: when.toISOString(),
            }),
          },
        )
        if (!res.ok) {
          const j = await res.json().catch(() => ({}))
          collected.push({
            productId,
            error: j.error ?? `HTTP ${res.status}`,
          })
        } else {
          scheduled++
        }
      } catch (e) {
        collected.push({
          productId,
          error: e instanceof Error ? e.message : String(e),
        })
      }
    }
    setSubmitting(false)
    setErrors(collected)
    if (scheduled > 0) {
      toast.success(
        `Scheduled ${scheduled} change${scheduled === 1 ? '' : 's'} for ${when.toLocaleString()}`,
      )
      emitInvalidation({
        type: 'product.updated',
        meta: {
          productIds: productIds.filter(
            (id) => !collected.some((e) => e.productId === id),
          ),
          source: 'bulk-schedule',
        },
      })
      if (collected.length === 0) {
        onComplete()
      }
    } else {
      toast.error(`No changes scheduled — ${collected.length} failed`)
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
          <Calendar size={14} /> Schedule change for {productIds.length}{' '}
          product{productIds.length === 1 ? '' : 's'}
        </span>
      }
      description="Applied automatically at the chosen time. The same cascades fire as a live edit (channel listings, audit log, invalidations)."
    >
        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Kind tabs */}
          <div className="inline-flex border border-slate-200 rounded overflow-hidden">
            {(['STATUS', 'PRICE'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={`px-4 h-8 text-base ${
                  kind === k
                    ? 'bg-slate-900 text-white'
                    : 'bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {k === 'STATUS' ? 'Status flip' : 'Price change'}
              </button>
            ))}
          </div>

          {/* Per-kind body */}
          {kind === 'STATUS' && (
            <div className="space-y-2">
              <label className="text-sm uppercase tracking-wider text-slate-500 font-semibold block">
                Set status to
              </label>
              <div className="inline-flex border border-slate-200 rounded overflow-hidden">
                {(['ACTIVE', 'DRAFT', 'INACTIVE'] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStatus(s)}
                    className={`px-4 h-8 text-base ${
                      status === s
                        ? 'bg-slate-900 text-white'
                        : 'bg-white text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {kind === 'PRICE' && (
            <div className="space-y-2">
              <label className="text-sm uppercase tracking-wider text-slate-500 font-semibold block">
                New price
              </label>
              <div className="inline-flex border border-slate-200 rounded overflow-hidden">
                <button
                  type="button"
                  onClick={() => setPriceMode('percent')}
                  className={`px-4 h-8 text-base ${
                    priceMode === 'percent'
                      ? 'bg-slate-900 text-white'
                      : 'bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  Adjust %
                </button>
                <button
                  type="button"
                  onClick={() => setPriceMode('absolute')}
                  className={`px-4 h-8 text-base ${
                    priceMode === 'absolute'
                      ? 'bg-slate-900 text-white'
                      : 'bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  Set absolute
                </button>
              </div>
              {priceMode === 'percent' ? (
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step="0.1"
                    value={pricePercent}
                    onChange={(e) => setPricePercent(e.target.value)}
                    className="w-28 h-8 px-2 text-base border border-slate-200 rounded tabular-nums"
                  />
                  <span className="text-base text-slate-700">%</span>
                  <span className="text-sm text-slate-500">
                    relative to current basePrice (negative = drop)
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-base text-slate-700">€</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={priceAbsolute}
                    onChange={(e) => setPriceAbsolute(e.target.value)}
                    placeholder="29.99"
                    className="w-32 h-8 px-2 text-base border border-slate-200 rounded tabular-nums"
                  />
                  <span className="text-sm text-slate-500">
                    overwrites basePrice for every selected product
                  </span>
                </div>
              )}
            </div>
          )}

          {/* DateTime */}
          <div className="space-y-2">
            <label
              htmlFor="schedule-when"
              className="text-sm uppercase tracking-wider text-slate-500 font-semibold block"
            >
              Apply at
            </label>
            <input
              id="schedule-when"
              type="datetime-local"
              value={scheduledFor}
              onChange={(e) => setScheduledFor(e.target.value)}
              className="h-8 px-2 text-base border border-slate-200 rounded"
            />
            <div className="text-sm text-slate-500">
              Local time. Applied within ~60s of the chosen moment by
              the scheduled-changes worker.
            </div>
          </div>

          {/* Per-product errors */}
          {errors.length > 0 && (
            <div className="border border-rose-200 bg-rose-50 rounded-md p-2 text-sm text-rose-800 space-y-1 max-h-32 overflow-y-auto">
              <div className="font-semibold">
                {errors.length} product{errors.length === 1 ? '' : 's'} failed:
              </div>
              {errors.slice(0, 8).map((e) => (
                <div key={e.productId} className="font-mono">
                  {e.productId.slice(0, 8)}… — {e.error}
                </div>
              ))}
              {errors.length > 8 && (
                <div className="italic">
                  …and {errors.length - 8} more
                </div>
              )}
            </div>
          )}
        </div>

        <ModalFooter className="!justify-between">
          <Button
            variant="secondary"
            onClick={onClose}
            disabled={submitting}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={submitting}
            className="bg-slate-900 text-white border-slate-900 hover:bg-slate-800"
            icon={
              submitting ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                <Calendar size={12} />
              )
            }
          >
            {submitting
              ? 'Scheduling…'
              : `Schedule ${productIds.length} product${productIds.length === 1 ? '' : 's'}`}
          </Button>
        </ModalFooter>
    </Modal>
  )
}
