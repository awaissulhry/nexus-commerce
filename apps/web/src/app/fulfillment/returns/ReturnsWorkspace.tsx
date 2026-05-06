'use client'

// FULFILLMENT B.7 — Returns. RMA → receive → inspect (condition grade) → restock or scrap → refund.
// Manual refund default (per user choice — they recheck before restock); auto-refund opt-in via toggle.

import { useCallback, useEffect, useState } from 'react'
import {
  Undo2, Plus, RefreshCw, X, CheckCircle2, Package,
  ChevronRight, ArrowDownToLine,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'

type ReturnRow = {
  id: string
  orderId: string | null
  channel: string
  marketplace: string | null
  rmaNumber: string | null
  status: string
  reason: string | null
  conditionGrade: string | null
  refundStatus: string
  refundCents: number | null
  isFbaReturn: boolean
  receivedAt: string | null
  inspectedAt: string | null
  refundedAt: string | null
  restockedAt: string | null
  notes: string | null
  items: Array<{ id: string; sku: string; productId: string | null; quantity: number; conditionGrade: string | null }>
  createdAt: string
}

const STATUS_TONE: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  REQUESTED: 'default',
  AUTHORIZED: 'info',
  IN_TRANSIT: 'info',
  RECEIVED: 'warning',
  INSPECTING: 'warning',
  RESTOCKED: 'success',
  REFUNDED: 'success',
  REJECTED: 'danger',
  SCRAPPED: 'danger',
}

const CHANNEL_TONE: Record<string, string> = {
  AMAZON: 'bg-orange-50 text-orange-700 border-orange-200',
  EBAY: 'bg-blue-50 text-blue-700 border-blue-200',
  SHOPIFY: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  WOOCOMMERCE: 'bg-violet-50 text-violet-700 border-violet-200',
  ETSY: 'bg-rose-50 text-rose-700 border-rose-200',
}

export default function ReturnsWorkspace() {
  const [tab, setTab] = useState<'ALL' | 'NON_FBA' | 'FBA'>('ALL')
  const [statusFilter, setStatusFilter] = useState<string>('ALL')
  const [items, setItems] = useState<ReturnRow[]>([])
  const [loading, setLoading] = useState(true)
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)

  const fetchReturns = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (statusFilter !== 'ALL') qs.set('status', statusFilter)
      if (tab === 'FBA') qs.set('fbaOnly', 'true')
      else if (tab === 'NON_FBA') qs.set('fbaOnly', 'false')
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns?${qs.toString()}`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setItems(data.items ?? [])
      }
    } finally { setLoading(false) }
  }, [tab, statusFilter])

  useEffect(() => { fetchReturns() }, [fetchReturns])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Returns"
        description="Receive, inspect, refund, and restock customer returns. FBA returns mirrored read-only from Amazon."
        breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Returns' }]}
      />

      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5">
          {(['ALL', 'NON_FBA', 'FBA'] as const).map((t) => (
            <button key={t} onClick={() => setTab(t)} className={`h-7 px-3 text-[12px] font-medium rounded transition-colors ${tab === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}>
              {t === 'NON_FBA' ? 'Warehouse' : t === 'FBA' ? 'FBA (read-only)' : 'All'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1">
          {['ALL', 'REQUESTED', 'RECEIVED', 'INSPECTING', 'RESTOCKED', 'REFUNDED'].map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)} className={`h-7 px-2 text-[11px] border rounded ${statusFilter === s ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200'}`}>{s.replace(/_/g, ' ')}</button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setCreateOpen(true)} className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 inline-flex items-center gap-1.5">
            <Plus size={12} /> New return
          </button>
          <button onClick={fetchReturns} className="h-8 px-3 text-[12px] border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      {loading && items.length === 0 ? (
        <Card><div className="text-[13px] text-slate-500 py-8 text-center">Loading returns…</div></Card>
      ) : items.length === 0 ? (
        <EmptyState icon={Undo2} title="No returns" description="Returns from Amazon FBA mirror automatically. Non-FBA returns are created when customers request RMAs." />
      ) : (
        <Card noPadding>
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="border-b border-slate-200 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">RMA</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">Channel</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">Status</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">Items</th>
                  <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-700">Reason</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700">Refund</th>
                  <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-700"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((r) => (
                  <tr key={r.id} onClick={() => setDrawerId(r.id)} className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer">
                    <td className="px-3 py-2 font-mono text-[12px] text-slate-700">{r.rmaNumber ?? '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${CHANNEL_TONE[r.channel] ?? 'bg-slate-50 text-slate-600 border-slate-200'}`}>{r.channel}</span>
                      {r.isFbaReturn && <span className="ml-1.5 text-[10px] font-mono text-orange-700">FBA</span>}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={STATUS_TONE[r.status] ?? 'default'} size="sm">{r.status.replace(/_/g, ' ')}</Badge>
                    </td>
                    <td className="px-3 py-2 text-[12px] text-slate-700">
                      <span className="tabular-nums">{r.items.reduce((n, i) => n + i.quantity, 0)}</span> units · {r.items.length} SKU
                    </td>
                    <td className="px-3 py-2 text-[12px] text-slate-600 truncate max-w-[200px]">{r.reason ?? '—'}</td>
                    <td className="px-3 py-2 text-right tabular-nums text-[12px] text-slate-700">
                      {r.refundCents != null ? `€${(r.refundCents / 100).toFixed(2)}` : '—'}
                    </td>
                    <td className="px-3 py-2 text-right"><ChevronRight size={14} className="text-slate-400 inline" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {drawerId && <ReturnDrawer id={drawerId} onClose={() => setDrawerId(null)} onChanged={fetchReturns} />}
      {createOpen && <CreateReturnModal onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); fetchReturns() }} />}
    </div>
  )
}

function ReturnDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [ret, setRet] = useState<ReturnRow | null>(null)
  const [loading, setLoading] = useState(true)
  const [conditions, setConditions] = useState<Record<string, string>>({})
  const [refundCents, setRefundCents] = useState<string>('')

  const fetchOne = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns/${id}`, { cache: 'no-store' })
      if (res.ok) setRet(await res.json())
    } finally { setLoading(false) }
  }, [id])

  useEffect(() => { fetchOne() }, [fetchOne])

  const [refundResult, setRefundResult] = useState<{
    outcome: string
    message?: string
    error?: string
    channelRefundId?: string
  } | null>(null)
  const [refundBusy, setRefundBusy] = useState(false)

  const action = async (path: string, body?: any) => {
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns/${id}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return alert(err.error ?? `${path} failed`)
    }
    await fetchOne()
    onChanged()
  }

  const submitInspect = () => {
    const items = ret?.items.map((it) => ({
      itemId: it.id,
      conditionGrade: conditions[it.id] || 'GOOD',
    })).filter((u) => u.conditionGrade) ?? []
    if (items.length === 0) return alert('Grade at least one item')
    action('inspect', { items })
  }

  /**
   * H.14 — submit refund publishes to the originating channel before
   * marking the local row REFUNDED. We surface the channel outcome
   * inline so the operator sees:
   *   OK                   → refund posted, channelRefundId rendered
   *   OK_MANUAL_REQUIRED   → Amazon FBM / FBA hint with deep link
   *   NOT_IMPLEMENTED      → Shopify/Woo stubbed, retry later
   *   FAILED               → channel rejected; retry button visible
   *
   * The "Mark refunded only (skip channel push)" button is a deliberate
   * override for when the operator already issued the refund in the
   * channel back office and just needs Nexus to reflect.
   */
  const submitRefund = async (skipChannelPush: boolean) => {
    const cents = refundCents ? Math.round(Number(refundCents) * 100) : null
    setRefundBusy(true)
    setRefundResult(null)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/fulfillment/returns/${id}/refund`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refundCents: cents, skipChannelPush }),
        },
      )
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        setRefundResult({
          outcome: 'FAILED',
          error: json?.channelError ?? json?.error ?? 'Refund failed',
        })
      } else {
        setRefundResult({
          outcome: json.channelOutcome ?? 'OK',
          message: json.channelMessage,
          channelRefundId: json.channelRefundId,
        })
        await fetchOne()
        onChanged()
      }
    } catch (e) {
      setRefundResult({
        outcome: 'FAILED',
        error: e instanceof Error ? e.message : String(e),
      })
    } finally {
      setRefundBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" />
      <aside onClick={(e) => e.stopPropagation()} className="relative h-full w-full max-w-2xl bg-white shadow-2xl overflow-y-auto">
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="text-[13px] font-semibold text-slate-900 inline-flex items-center gap-2">
            <Undo2 size={14} /> Return {ret?.rmaNumber}
          </div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-4">
          {loading || !ret ? <div className="text-[12px] text-slate-500">Loading…</div> : (
            <>
              <div className="flex items-center gap-2">
                <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${CHANNEL_TONE[ret.channel] ?? ''}`}>{ret.channel}</span>
                <Badge variant={STATUS_TONE[ret.status] ?? 'default'} size="sm">{ret.status.replace(/_/g, ' ')}</Badge>
                {ret.isFbaReturn && <span className="text-[10px] font-mono text-orange-700">FBA — managed by Amazon</span>}
              </div>

              {ret.reason && <div><div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">Reason</div><div className="text-[12px] text-slate-700 mt-0.5">{ret.reason}</div></div>}

              <div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold mb-2">Items</div>
                <table className="w-full text-[12px]">
                  <thead className="border-b border-slate-200">
                    <tr>
                      <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase text-slate-500">SKU</th>
                      <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase text-slate-500">Qty</th>
                      <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase text-slate-500">Condition</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ret.items.map((it) => (
                      <tr key={it.id} className="border-b border-slate-100">
                        <td className="px-2 py-1.5 font-mono text-slate-700">{it.sku}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{it.quantity}</td>
                        <td className="px-2 py-1.5">
                          {ret.status === 'INSPECTING' || ret.status === 'RECEIVED' ? (
                            <select
                              value={conditions[it.id] ?? it.conditionGrade ?? ''}
                              onChange={(e) => setConditions({ ...conditions, [it.id]: e.target.value })}
                              className="h-7 px-2 text-[11px] border border-slate-200 rounded"
                            >
                              <option value="">Grade…</option>
                              <option value="NEW">NEW</option>
                              <option value="LIKE_NEW">Like new</option>
                              <option value="GOOD">Good</option>
                              <option value="DAMAGED">Damaged</option>
                              <option value="UNUSABLE">Unusable</option>
                            </select>
                          ) : (
                            <span className="text-[11px] text-slate-600">{it.conditionGrade ?? '—'}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {!ret.isFbaReturn && (
                <div className="pt-3 border-t border-slate-100 space-y-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    {ret.status === 'REQUESTED' || ret.status === 'AUTHORIZED' || ret.status === 'IN_TRANSIT' ? (
                      <button onClick={() => action('receive')} className="h-8 px-3 text-[12px] bg-blue-50 text-blue-700 border border-blue-200 rounded hover:bg-blue-100 inline-flex items-center gap-1.5">
                        <ArrowDownToLine size={12} /> Mark received
                      </button>
                    ) : null}
                    {(ret.status === 'RECEIVED' || ret.status === 'INSPECTING') && (
                      <button onClick={submitInspect} className="h-8 px-3 text-[12px] bg-amber-50 text-amber-700 border border-amber-200 rounded hover:bg-amber-100 inline-flex items-center gap-1.5">
                        <CheckCircle2 size={12} /> Save inspection
                      </button>
                    )}
                    {ret.status === 'INSPECTING' && (
                      <>
                        <button onClick={() => action('restock')} className="h-8 px-3 text-[12px] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1.5">
                          <Package size={12} /> Restock
                        </button>
                        <button onClick={() => action('scrap')} className="h-8 px-3 text-[12px] bg-rose-50 text-rose-700 border border-rose-200 rounded hover:bg-rose-100">Scrap</button>
                      </>
                    )}
                  </div>

                  {ret.refundStatus !== 'REFUNDED' && (
                    <div className="pt-2 border-t border-slate-100 space-y-2">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[11px] text-slate-500 mr-1">Refund:</span>
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={refundCents}
                          onChange={(e) => setRefundCents(e.target.value)}
                          placeholder="0.00"
                          className="h-8 w-24 px-2 text-right tabular-nums border border-slate-200 rounded text-[12px]"
                        />
                        <span className="text-[11px] text-slate-500">€</span>
                        <button
                          onClick={() => submitRefund(false)}
                          disabled={refundBusy}
                          className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50 inline-flex items-center gap-1.5"
                          title={`Issue refund on ${ret.channel} and mark refunded locally`}
                        >
                          {refundBusy ? '…' : `Refund on ${ret.channel}`}
                        </button>
                        <button
                          onClick={() => submitRefund(true)}
                          disabled={refundBusy}
                          className="h-8 px-3 text-[12px] border border-slate-200 text-slate-600 rounded hover:bg-slate-50 disabled:opacity-50"
                          title="Already refunded in channel back office — just mark Nexus"
                        >
                          Mark only
                        </button>
                      </div>
                      {/* H.14 — channel outcome surface. Each tone
                          maps to one of the four publisher outcomes. */}
                      {refundResult && (
                        <div
                          className={`text-[11px] rounded px-2.5 py-1.5 ${
                            refundResult.outcome === 'OK'
                              ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                              : refundResult.outcome === 'OK_MANUAL_REQUIRED'
                                ? 'bg-amber-50 border border-amber-200 text-amber-800'
                                : refundResult.outcome === 'NOT_IMPLEMENTED'
                                  ? 'bg-slate-50 border border-slate-200 text-slate-700'
                                  : 'bg-rose-50 border border-rose-200 text-rose-800'
                          }`}
                        >
                          <div className="font-medium">
                            {refundResult.outcome === 'OK' && 'Refund posted to channel.'}
                            {refundResult.outcome === 'OK_MANUAL_REQUIRED' && 'Channel requires manual finish.'}
                            {refundResult.outcome === 'NOT_IMPLEMENTED' && 'Channel adapter not yet wired.'}
                            {refundResult.outcome === 'SKIPPED' && 'Marked refunded locally (channel skipped).'}
                            {refundResult.outcome === 'FAILED' && 'Channel push failed.'}
                          </div>
                          {refundResult.channelRefundId && (
                            <div className="mt-0.5 font-mono text-[10px]">
                              Channel refund id: {refundResult.channelRefundId}
                            </div>
                          )}
                          {refundResult.message && (
                            <div className="mt-0.5">{refundResult.message}</div>
                          )}
                          {refundResult.error && (
                            <div className="mt-0.5 font-mono text-[10px]">
                              {refundResult.error}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {ret.refundStatus === 'REFUNDED' && (ret as any).channelRefundId && (
                    <div className="text-[11px] text-emerald-700 pt-1">
                      Channel refund id:{' '}
                      <span className="font-mono">
                        {(ret as any).channelRefundId}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

function CreateReturnModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [orderId, setOrderId] = useState('')
  const [channel, setChannel] = useState('AMAZON')
  const [reason, setReason] = useState('')
  const [items, setItems] = useState<Array<{ sku: string; quantity: number }>>([{ sku: '', quantity: 1 }])
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/returns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: orderId || null, channel, reason,
          items: items.filter((i) => i.sku.trim()),
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error ?? 'Create failed')
      }
      onCreated()
    } catch (e: any) {
      alert(e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-6" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40" />
      <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-lg shadow-2xl w-full max-w-xl">
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <div className="text-[14px] font-semibold text-slate-900">New return</div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Channel</div>
              <select value={channel} onChange={(e) => setChannel(e.target.value)} className="h-8 w-full px-2 text-[13px] border border-slate-200 rounded">
                <option value="AMAZON">Amazon</option>
                <option value="EBAY">eBay</option>
                <option value="SHOPIFY">Shopify</option>
                <option value="WOOCOMMERCE">WooCommerce</option>
                <option value="ETSY">Etsy</option>
              </select>
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Order ID (optional)</div>
              <input type="text" value={orderId} onChange={(e) => setOrderId(e.target.value)} className="h-8 w-full px-2 text-[13px] font-mono border border-slate-200 rounded" />
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Reason</div>
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Wrong size, defective, …" className="h-8 w-full px-2 text-[13px] border border-slate-200 rounded" />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Items</div>
            <div className="space-y-1.5">
              {items.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="text" value={row.sku} onChange={(e) => setItems(items.map((s, j) => j === i ? { ...s, sku: e.target.value } : s))} placeholder="SKU" className="flex-1 h-7 px-2 text-[12px] font-mono border border-slate-200 rounded" />
                  <input type="number" min="1" value={row.quantity} onChange={(e) => setItems(items.map((s, j) => j === i ? { ...s, quantity: Number(e.target.value) || 1 } : s))} className="h-7 w-20 px-2 text-right tabular-nums border border-slate-200 rounded" />
                  <button onClick={() => setItems(items.filter((_, j) => j !== i))} className="h-7 w-7 inline-flex items-center justify-center text-slate-400 hover:text-rose-600"><X size={14} /></button>
                </div>
              ))}
            </div>
            <button onClick={() => setItems([...items, { sku: '', quantity: 1 }])} className="mt-2 text-[11px] text-blue-600 hover:underline">+ Add SKU</button>
          </div>
        </div>
        <footer className="px-5 py-3 border-t border-slate-200 flex items-center gap-2 justify-end">
          <button onClick={onClose} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Cancel</button>
          <button onClick={submit} disabled={busy} className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50">Create return</button>
        </footer>
      </div>
    </div>
  )
}
