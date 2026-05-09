'use client'

/**
 * L.6 — Recall detail page. Closes the loop L.5 promised by linking
 * to /recalls/:id from the dashboard.
 *
 * Renders three sections fed by /api/stock/lots/:lotId/trace:
 *   1. Recall header (status, reason, opened/closed timeline)
 *   2. Lot provenance (backward trace — origin PO / inbound / receive
 *      movement) — the "where did this batch come from" answer
 *   3. Affected orders (forward trace — every StockMovement that
 *      touched this lot, with its orderId / shipmentId / returnId)
 *      — the GPSR Article 19 "buyers to notify" report
 *
 * Operator can copy the orderId list directly to send recall notices.
 */

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import {
  ShieldAlert, ChevronLeft, RefreshCw, AlertCircle, Package,
  ArrowRight, Truck, Clipboard,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
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
    receivedAt: string
    expiresAt: string | null
    unitsRemaining: number
    unitsReceived: number
    product: { id: string; sku: string; name: string }
  }
}

interface ForwardTrace {
  lot: {
    id: string
    lotNumber: string
    product: { id: string; sku: string; name: string }
  }
  movements: Array<{
    id: string
    createdAt: string
    change: number
    balanceAfter: number
    reason: string
    referenceType: string | null
    referenceId: string | null
    orderId: string | null
    shipmentId: string | null
    returnId: string | null
    locationId: string | null
    actor: string | null
    notes: string | null
  }>
  affected: {
    orderIds: string[]
    shipmentIds: string[]
    returnIds: string[]
  }
}

interface BackwardTrace {
  lot: {
    id: string
    lotNumber: string
    product: { id: string; sku: string; name: string }
  }
  originReceiveMovement: {
    id: string
    createdAt: string
    change: number
    reason: string
    actor: string | null
    notes: string | null
  } | null
  originPoId: string | null
  originInboundShipmentId: string | null
  supplierLotRef: string | null
}

export default function RecallDetailClient({ recallId }: { recallId: string }) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [recall, setRecall] = useState<Recall | null>(null)
  const [forward, setForward] = useState<ForwardTrace | null>(null)
  const [backward, setBackward] = useState<BackwardTrace | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [closing, setClosing] = useState(false)

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      // L.7 — direct fetch via /recalls/:id. Replaces the earlier
      // list-and-filter workaround that scaled with total recall count.
      const recallRes = await fetch(
        `${getBackendUrl()}/api/stock/recalls/${recallId}`,
        { cache: 'no-store' },
      )
      if (recallRes.status === 404) throw new Error(t('stock.recallDetail.notFound'))
      if (!recallRes.ok) throw new Error(`recall HTTP ${recallRes.status}`)
      const r = (await recallRes.json()) as Recall
      setRecall(r)

      const traceRes = await fetch(
        `${getBackendUrl()}/api/stock/lots/${r.lotId}/trace`,
        { cache: 'no-store' },
      )
      if (!traceRes.ok) throw new Error(`trace HTTP ${traceRes.status}`)
      const trace = await traceRes.json()
      setForward(trace.forward)
      setBackward(trace.backward)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [recallId, t])

  useEffect(() => { fetchData() }, [fetchData])

  const closeRecall = useCallback(async () => {
    if (!recall) return
    setClosing(true)
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
      await fetchData()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setClosing(false)
    }
  }, [recall, fetchData, toast, t])

  const [releasing, setReleasing] = useState(false)
  const releaseReservations = useCallback(async () => {
    if (!recall) return
    if (!confirm(t('stock.recallDetail.releaseConfirm'))) return
    setReleasing(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/stock/recalls/${recall.id}/release-reservations`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
      const body = await res.json() as { released: number }
      toast.success(t('stock.recallDetail.releasedToast', { n: body.released }))
      await fetchData()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setReleasing(false)
    }
  }, [recall, fetchData, toast, t])

  const copyOrderIds = useCallback(async () => {
    if (!forward?.affected.orderIds.length) return
    const text = forward.affected.orderIds.join('\n')
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t('stock.recallDetail.copiedToast', { n: forward.affected.orderIds.length }))
    } catch {
      toast.error(t('stock.recallDetail.copyFailed'))
    }
  }, [forward, toast, t])

  return (
    <div className="p-3 sm:p-6 space-y-3 sm:space-y-6">
      <PageHeader
        title={recall ? t('stock.recallDetail.title', { lot: recall.lot.lotNumber }) : t('stock.recalls.title')}
        description={recall?.reason ?? t('stock.recallDetail.loading')}
        breadcrumbs={[
          { label: t('nav.fulfillment'), href: '/fulfillment' },
          { label: t('stock.title'), href: '/fulfillment/stock' },
          { label: t('stock.recalls.title'), href: '/fulfillment/stock/recalls' },
          { label: recall?.lot.lotNumber ?? '…' },
        ]}
        actions={
          <div className="inline-flex items-center gap-2">
            <Link
              href="/fulfillment/stock/recalls"
              className="h-8 px-3 inline-flex items-center gap-1 text-sm text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 border border-slate-200 dark:border-slate-700 rounded"
            >
              <ChevronLeft size={12} aria-hidden="true" /> {t('common.back')}
            </Link>
            <Button variant="secondary" size="sm" onClick={fetchData} disabled={loading}>
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} aria-hidden="true" />
            </Button>
            {recall?.status === 'OPEN' && (
              <Button variant="secondary" size="sm" onClick={closeRecall} disabled={closing}>
                {closing ? t('stock.recallDetail.closing') : t('stock.recalls.close')}
              </Button>
            )}
          </div>
        }
      />

      {error && (
        <Card>
          <div className="text-rose-700 inline-flex items-center gap-2">
            <AlertCircle size={14} aria-hidden="true" /> {error}
          </div>
        </Card>
      )}

      {recall && (
        <Card>
          <div className="flex items-start gap-3 flex-wrap">
            <Badge variant={recall.status === 'OPEN' ? 'danger' : 'default'} size="sm">
              {t(`stock.recalls.status.${recall.status.toLowerCase()}` as any)}
            </Badge>
            <div className="min-w-0 flex-1">
              <div className="text-md font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-2">
                <Package size={14} aria-hidden="true" className="text-slate-400" />
                <span className="font-mono">{recall.lot.lotNumber}</span>
                <span className="text-slate-500 dark:text-slate-400 font-normal truncate">
                  {recall.lot.product.sku} · {recall.lot.product.name}
                </span>
              </div>
              <div className="text-sm text-slate-700 dark:text-slate-300 mt-1">
                {recall.reason}
              </div>
              <div className="text-xs text-slate-500 dark:text-slate-400 mt-2 flex items-center gap-4 flex-wrap tabular-nums">
                <span>
                  {t('stock.recalls.opened', { when: formatRelative(recall.openedAt, t) })}
                  {recall.openedBy && <> · {recall.openedBy}</>}
                </span>
                <span>
                  {t('stock.recalls.lotState', {
                    remaining: recall.lot.unitsRemaining,
                    received: recall.lot.unitsReceived,
                  })}
                </span>
                {recall.lot.expiresAt && (
                  <span>
                    {t('stock.recallDetail.expires', { when: new Date(recall.lot.expiresAt).toLocaleDateString() })}
                  </span>
                )}
                {recall.closedAt && (
                  <span className="text-emerald-700">
                    {t('stock.recalls.closed', { when: formatRelative(recall.closedAt, t) })}
                  </span>
                )}
              </div>
            </div>
          </div>
        </Card>
      )}

      {/* Backward trace — provenance */}
      {backward && (
        <Card title={t('stock.recallDetail.backwardTitle')} description={t('stock.recallDetail.backwardDescription')}>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-slate-500 dark:text-slate-400 uppercase text-xs font-semibold tracking-wider mb-1">
                {t('stock.recallDetail.originReceive')}
              </dt>
              <dd className="text-slate-700 dark:text-slate-300">
                {backward.originReceiveMovement
                  ? <>+{backward.originReceiveMovement.change} · {formatRelative(backward.originReceiveMovement.createdAt, t)} · {backward.originReceiveMovement.actor ?? '—'}</>
                  : <span className="text-slate-400">—</span>}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400 uppercase text-xs font-semibold tracking-wider mb-1">
                {t('stock.recallDetail.originPo')}
              </dt>
              <dd className="text-slate-700 dark:text-slate-300 font-mono">
                {backward.originPoId ?? <span className="text-slate-400">—</span>}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400 uppercase text-xs font-semibold tracking-wider mb-1">
                {t('stock.recallDetail.originInbound')}
              </dt>
              <dd className="text-slate-700 dark:text-slate-300 font-mono">
                {backward.originInboundShipmentId ?? <span className="text-slate-400">—</span>}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500 dark:text-slate-400 uppercase text-xs font-semibold tracking-wider mb-1">
                {t('stock.recallDetail.supplierLotRef')}
              </dt>
              <dd className="text-slate-700 dark:text-slate-300 font-mono">
                {backward.supplierLotRef ?? <span className="text-slate-400">—</span>}
              </dd>
            </div>
          </dl>
        </Card>
      )}

      {/* Forward trace — affected orders */}
      {forward && (
        <Card
          title={t('stock.recallDetail.forwardTitle', {
            n: forward.affected.orderIds.length,
          })}
          description={t('stock.recallDetail.forwardDescription')}
          action={
            forward.affected.orderIds.length > 0 ? (
              <Button variant="secondary" size="sm" onClick={copyOrderIds}>
                <Clipboard size={12} aria-hidden="true" /> {t('stock.recallDetail.copyOrderIds')}
              </Button>
            ) : undefined
          }
        >
          {forward.movements.length === 0 ? (
            <div className="text-sm text-slate-500 dark:text-slate-400 italic">
              {t('stock.recallDetail.noMovements')}
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="border-b border-slate-200 dark:border-slate-700 text-left">
                  <tr>
                    <th className="px-2 py-1.5 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('stock.recallDetail.col.when')}</th>
                    <th className="px-2 py-1.5 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('stock.recallDetail.col.change')}</th>
                    <th className="px-2 py-1.5 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('stock.recallDetail.col.reason')}</th>
                    <th className="px-2 py-1.5 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('stock.recallDetail.col.ref')}</th>
                    <th className="px-2 py-1.5 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">{t('stock.recallDetail.col.actor')}</th>
                  </tr>
                </thead>
                <tbody>
                  {forward.movements.map((m) => (
                    <tr key={m.id} className="border-b border-slate-100 dark:border-slate-800 last:border-0">
                      <td className="px-2 py-1.5 text-slate-500 dark:text-slate-400 tabular-nums whitespace-nowrap">
                        {formatRelative(m.createdAt, t)}
                      </td>
                      <td className="px-2 py-1.5 tabular-nums whitespace-nowrap font-medium">
                        <span className={m.change < 0 ? 'text-rose-600' : 'text-emerald-600'}>
                          {m.change > 0 ? '+' : ''}{m.change}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 text-slate-700 dark:text-slate-300 font-mono text-xs">
                        {m.reason}
                      </td>
                      <td className="px-2 py-1.5 text-slate-700 dark:text-slate-300 font-mono text-xs">
                        {m.orderId
                          ? <Link href={`/orders/${m.orderId}`} className="text-blue-700 hover:underline inline-flex items-center gap-1"><Truck size={10} aria-hidden="true" />{m.orderId.slice(0, 8)}</Link>
                          : m.shipmentId
                            ? <span className="inline-flex items-center gap-1"><ArrowRight size={10} aria-hidden="true" />{m.shipmentId.slice(0, 8)}</span>
                            : m.returnId
                              ? <span>↩ {m.returnId.slice(0, 8)}</span>
                              : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="px-2 py-1.5 text-slate-500 dark:text-slate-400 text-xs truncate max-w-[160px]">
                        {m.actor ?? '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {recall?.status === 'OPEN' && (
        <Card>
          <div className="flex items-start gap-2 text-amber-800 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded p-3">
            <ShieldAlert size={16} aria-hidden="true" className="mt-0.5 flex-shrink-0" />
            <div className="text-sm flex-1">
              {t('stock.recallDetail.openNote')}
              <div className="mt-2">
                <Button variant="secondary" size="sm" onClick={releaseReservations} disabled={releasing}>
                  {releasing ? t('stock.recallDetail.releasing') : t('stock.recallDetail.releaseReservations')}
                </Button>
                <span className="ml-2 text-xs text-amber-700">
                  {t('stock.recallDetail.releaseHint')}
                </span>
              </div>
            </div>
          </div>
        </Card>
      )}
    </div>
  )
}
