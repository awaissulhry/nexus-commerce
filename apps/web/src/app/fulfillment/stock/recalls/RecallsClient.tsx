'use client'

/**
 * L.5 — Lot recall dashboard. Lists OPEN recalls by default (the set
 * that needs operator attention) with toggle to CLOSED/ALL for audit.
 *
 * For each recall row:
 *   - Product + lot number (with link to forward-trace)
 *   - Reason (operator's note from open time)
 *   - Opened at + by
 *   - Affected order count (forward-trace summary, fetched lazily)
 *   - Close button (when status=OPEN)
 *
 * Open-recall flow: pick a lot from the lot list, type a reason, submit.
 * Once open, FEFO consume immediately stops allocating that lot.
 */

import { useCallback, useEffect, useState } from 'react'
import {
  ShieldAlert, RefreshCw, Plus, Check, AlertCircle,
} from 'lucide-react'
import Link from 'next/link'
import PageHeader from '@/components/layout/PageHeader'
import { StockSubNav } from '@/components/inventory/StockSubNav'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'
import { formatRelative } from '@/components/inventory/formatRelative'

interface Recall {
  id: string
  lotId: string
  reason: string
  status: 'OPEN' | 'CLOSED'
  openedAt: string
  openedBy: string | null
  closedAt: string | null
  closedBy: string | null
  notes: string | null
  lot: {
    id: string
    lotNumber: string
    expiresAt: string | null
    unitsRemaining: number
    unitsReceived: number
    product: { id: string; sku: string; name: string }
  }
}

type StatusFilter = 'OPEN' | 'CLOSED' | 'ALL'

export default function RecallsClient() {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [recalls, setRecalls] = useState<Recall[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('OPEN')
  const [closingId, setClosingId] = useState<string | null>(null)
  const [openModal, setOpenModal] = useState(false)

  const fetchRecalls = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/stock/recalls?status=${statusFilter}`,
        { cache: 'no-store' },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      setRecalls(body.items)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [statusFilter])

  useEffect(() => { fetchRecalls() }, [fetchRecalls])

  const closeRecall = useCallback(async (recall: Recall) => {
    setClosingId(recall.id)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/stock/recalls/${recall.id}/close`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      toast.success(t('stock.recalls.closedToast', { lot: recall.lot.lotNumber }))
      await fetchRecalls()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setClosingId(null)
    }
  }, [fetchRecalls, toast, t])

  const openRecallsCount = recalls?.filter((r) => r.status === 'OPEN').length ?? 0

  return (
    <div className="p-3 sm:p-6 space-y-3 sm:space-y-6">
      <PageHeader
        title={t('stock.recalls.title')}
        description={t('stock.recalls.description')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('stock.recalls.title') },
        ]}
      />
      <StockSubNav recallsOpen={openRecallsCount} />

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="inline-flex items-center gap-1 border border-slate-200 dark:border-slate-700 rounded-md p-0.5">
          {(['OPEN', 'CLOSED', 'ALL'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatusFilter(s)}
              className={
                'h-8 px-3 text-sm rounded ' +
                (statusFilter === s
                  ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                  : 'text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800')
              }
              aria-pressed={statusFilter === s}
            >
              {t(`stock.recalls.filter.${s.toLowerCase()}` as any)}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center gap-2">
          <Button variant="secondary" size="sm" onClick={fetchRecalls} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
            {t('stock.action.refresh')}
          </Button>
          <Button variant="primary" size="sm" onClick={() => setOpenModal(true)}>
            <Plus size={12} aria-hidden="true" /> {t('stock.recalls.openNew')}
          </Button>
        </div>
      </div>

      {error && (
        <Card>
          <div className="text-rose-700 inline-flex items-center gap-2">
            <AlertCircle size={14} aria-hidden="true" /> {error}
          </div>
        </Card>
      )}

      {!loading && recalls?.length === 0 && (
        <EmptyState
          icon={ShieldAlert}
          title={t(
            statusFilter === 'OPEN'
              ? 'stock.recalls.empty.open'
              : 'stock.recalls.empty.other',
          )}
          description={t('stock.recalls.empty.description')}
        />
      )}

      {recalls && recalls.length > 0 && (
        <Card noPadding>
          <ul className="divide-y divide-slate-100 dark:divide-slate-800">
            {recalls.map((r) => (
              <li key={r.id} className="p-3 sm:p-4 flex items-start gap-3 flex-wrap sm:flex-nowrap">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant={r.status === 'OPEN' ? 'danger' : 'default'} size="sm">
                      {t(`stock.recalls.status.${r.status.toLowerCase()}` as any)}
                    </Badge>
                    <span className="font-mono text-sm text-slate-700 dark:text-slate-300">{r.lot.lotNumber}</span>
                    <span className="text-sm text-slate-500 dark:text-slate-400 truncate">
                      {r.lot.product.sku} · {r.lot.product.name}
                    </span>
                  </div>
                  <div className="text-sm text-slate-700 dark:text-slate-300 mt-1">
                    {r.reason}
                  </div>
                  <div className="text-xs text-slate-500 dark:text-slate-400 mt-1 flex items-center gap-3 flex-wrap">
                    <span>
                      {t('stock.recalls.opened', { when: formatRelative(r.openedAt, t) })}
                      {r.openedBy && <> · {r.openedBy}</>}
                    </span>
                    <span>
                      {t('stock.recalls.lotState', {
                        remaining: r.lot.unitsRemaining,
                        received: r.lot.unitsReceived,
                      })}
                    </span>
                    {r.closedAt && (
                      <span className="text-emerald-700">
                        {t('stock.recalls.closed', { when: formatRelative(r.closedAt, t) })}
                      </span>
                    )}
                    <Link
                      href={`/fulfillment/stock/recalls/${r.id}`}
                      className="text-blue-700 hover:underline"
                    >
                      {t('stock.recalls.viewTrace')}
                    </Link>
                  </div>
                </div>
                {r.status === 'OPEN' && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => closeRecall(r)}
                    disabled={closingId === r.id}
                  >
                    <Check size={12} aria-hidden="true" /> {t('stock.recalls.close')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {openModal && (
        <OpenRecallModal
          onCancel={() => setOpenModal(false)}
          onConfirmed={async () => {
            setOpenModal(false)
            await fetchRecalls()
          }}
        />
      )}
    </div>
  )
}

function OpenRecallModal({
  onCancel,
  onConfirmed,
}: {
  onCancel: () => void
  onConfirmed: () => void | Promise<void>
}) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [lotNumber, setLotNumber] = useState('')
  const [productId, setProductId] = useState('')
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = useCallback(async () => {
    if (!productId.trim() || !lotNumber.trim() || !reason.trim()) {
      toast.error(t('stock.recalls.openModal.errMissing'))
      return
    }
    setSubmitting(true)
    try {
      // Look up the lot first so we can show a clear error if the lot
      // doesn't exist or already has an OPEN recall.
      const lotsRes = await fetch(
        `${getBackendUrl()}/api/stock/lots?productId=${encodeURIComponent(productId)}&activeOnly=0&limit=200`,
        { cache: 'no-store' },
      )
      if (!lotsRes.ok) throw new Error(`HTTP ${lotsRes.status}`)
      const { items } = await lotsRes.json()
      const target = items.find((l: any) => l.lotNumber === lotNumber.trim())
      if (!target) throw new Error(t('stock.recalls.openModal.lotNotFound'))

      const res = await fetch(`${getBackendUrl()}/api/stock/recalls`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lotId: target.id, reason }),
      })
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      const body = await res.json()
      if (body.alreadyOpen) {
        toast.success(t('stock.recalls.openModal.alreadyOpen'))
      } else {
        toast.success(t('stock.recalls.openModal.opened', { lot: lotNumber }))
      }
      await onConfirmed()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }, [productId, lotNumber, reason, toast, t, onConfirmed])

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center"
      role="dialog"
      aria-modal="true"
      aria-label={t('stock.recalls.openModal.title')}
      onClick={onCancel}
    >
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" />
      <div
        onClick={(e) => e.stopPropagation()}
        className="relative bg-white dark:bg-slate-900 rounded-lg shadow-2xl max-w-lg w-full mx-4 max-h-[80vh] overflow-y-auto"
      >
        <header className="px-5 py-3 border-b border-slate-200 dark:border-slate-700">
          <div className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            {t('stock.recalls.openModal.title')}
          </div>
        </header>
        <div className="p-5 space-y-3">
          <div>
            <label
              htmlFor="recall-product-id"
              className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block mb-1"
            >
              {t('stock.recalls.openModal.productIdLabel')}
            </label>
            <input
              id="recall-product-id"
              type="text"
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              placeholder={t('stock.recalls.openModal.productIdPlaceholder')}
              className="w-full h-9 px-2 text-md border border-slate-200 dark:border-slate-700 rounded font-mono"
            />
          </div>
          <div>
            <label
              htmlFor="recall-lot-number"
              className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block mb-1"
            >
              {t('stock.recalls.openModal.lotLabel')}
            </label>
            <input
              id="recall-lot-number"
              type="text"
              value={lotNumber}
              onChange={(e) => setLotNumber(e.target.value)}
              placeholder={t('stock.recalls.openModal.lotPlaceholder')}
              autoFocus
              className="w-full h-9 px-2 text-md border border-slate-200 dark:border-slate-700 rounded font-mono"
            />
          </div>
          <div>
            <label
              htmlFor="recall-reason"
              className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold block mb-1"
            >
              {t('stock.recalls.openModal.reasonLabel')}
            </label>
            <textarea
              id="recall-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              placeholder={t('stock.recalls.openModal.reasonPlaceholder')}
              className="w-full px-3 py-2 text-base border border-slate-200 dark:border-slate-700 rounded"
            />
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded p-2">
            {t('stock.recalls.openModal.fefoNote')}
          </div>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100 dark:border-slate-800">
            <button
              onClick={onCancel}
              className="h-11 sm:h-8 px-3 text-base text-slate-500 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={submit}
              disabled={submitting}
              className="h-11 sm:h-8 px-3 text-base bg-rose-700 text-white rounded hover:bg-rose-800 disabled:opacity-50 inline-flex items-center gap-1.5"
            >
              <ShieldAlert size={12} aria-hidden="true" />
              {submitting ? t('stock.recalls.openModal.submitting') : t('stock.recalls.openModal.submit')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
