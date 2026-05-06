'use client'

// FULFILLMENT B.5 / B.6 — Inbound. Two lanes: WAREHOUSE (suppliers + manufacturing
// + transfers) and FBA (Send-to-Amazon end-to-end). Both share the InboundShipment
// model so the audit trail is unified.

import { useCallback, useEffect, useState } from 'react'
import {
  PackageCheck, Plus, RefreshCw, Truck, X,
  ArrowDownToLine, ChevronRight,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { EmptyState } from '@/components/ui/EmptyState'
import { getBackendUrl } from '@/lib/backend-url'

type Inbound = {
  id: string
  type: 'FBA' | 'SUPPLIER' | 'MANUFACTURING' | 'TRANSFER'
  status: string
  reference: string | null
  warehouseId: string | null
  fbaShipmentId: string | null
  purchaseOrderId: string | null
  workOrderId: string | null
  asnNumber: string | null
  expectedAt: string | null
  arrivedAt: string | null
  closedAt: string | null
  notes: string | null
  warehouse?: { code: string; name: string } | null
  purchaseOrder?: { poNumber: string; supplierId: string | null } | null
  workOrder?: { id: string; productId: string; quantity: number } | null
  items: Array<{ id: string; sku: string; productId: string | null; quantityExpected: number; quantityReceived: number; qcStatus: string | null }>
  createdAt: string
}

const TYPE_TONE: Record<string, string> = {
  FBA: 'bg-orange-50 text-orange-700 border-orange-200',
  SUPPLIER: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  MANUFACTURING: 'bg-violet-50 text-violet-700 border-violet-200',
  TRANSFER: 'bg-blue-50 text-blue-700 border-blue-200',
}

const STATUS_TONE: Record<string, 'default' | 'success' | 'warning' | 'danger' | 'info'> = {
  DRAFT: 'default',
  IN_TRANSIT: 'info',
  ARRIVED: 'warning',
  RECEIVING: 'warning',
  CLOSED: 'success',
  CANCELLED: 'default',
}

export default function InboundWorkspace() {
  const [tab, setTab] = useState<'ALL' | 'FBA' | 'SUPPLIER' | 'MANUFACTURING' | 'TRANSFER'>('ALL')
  const [items, setItems] = useState<Inbound[]>([])
  const [loading, setLoading] = useState(true)
  const [drawerId, setDrawerId] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [fbaWizardOpen, setFbaWizardOpen] = useState(false)

  const fetchAll = useCallback(async () => {
    setLoading(true)
    try {
      const qs = new URLSearchParams()
      if (tab !== 'ALL') qs.set('type', tab)
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound?${qs.toString()}`, { cache: 'no-store' })
      if (res.ok) {
        const data = await res.json()
        setItems(data.items ?? [])
      }
    } finally { setLoading(false) }
  }, [tab])

  useEffect(() => { fetchAll() }, [fetchAll])

  return (
    <div className="space-y-5">
      <PageHeader
        title="Inbound Shipments"
        description="Receive from suppliers + manufacturing into the warehouse, or send to Amazon FBA end-to-end."
        breadcrumbs={[{ label: 'Fulfillment', href: '/fulfillment' }, { label: 'Inbound' }]}
      />

      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center bg-slate-100 rounded-md p-0.5">
          {(['ALL', 'SUPPLIER', 'MANUFACTURING', 'TRANSFER', 'FBA'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`h-7 px-3 text-[12px] font-medium rounded transition-colors ${tab === t ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`}
            >{t === 'SUPPLIER' ? 'From Suppliers' : t === 'MANUFACTURING' ? 'In-house' : t === 'FBA' ? 'To Amazon FBA' : t === 'TRANSFER' ? 'Transfers' : 'All'}</button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setFbaWizardOpen(true)} className="h-8 px-3 text-[12px] bg-orange-50 text-orange-700 border border-orange-200 rounded hover:bg-orange-100 inline-flex items-center gap-1.5">
            <Truck size={12} /> Send to Amazon FBA
          </button>
          <button onClick={() => setCreateOpen(true)} className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 inline-flex items-center gap-1.5">
            <Plus size={12} /> New inbound
          </button>
          <button onClick={fetchAll} className="h-8 px-3 text-[12px] border border-slate-200 rounded-md hover:bg-slate-50 inline-flex items-center gap-1.5">
            <RefreshCw size={12} /> Refresh
          </button>
        </div>
      </div>

      {loading && items.length === 0 ? (
        <Card><div className="text-[13px] text-slate-500 py-8 text-center">Loading inbound…</div></Card>
      ) : items.length === 0 ? (
        <EmptyState
          icon={PackageCheck}
          title="No inbound shipments"
          description={tab === 'FBA' ? 'Use "Send to Amazon FBA" to plan a shipment.' : 'Receipts from suppliers or manufacturing show up here.'}
          action={{ label: tab === 'FBA' ? 'Plan FBA shipment' : 'New inbound', href: '#' }}
        />
      ) : (
        <div className="grid gap-3">
          {items.map((it) => {
            const totalExpected = it.items.reduce((n, i) => n + i.quantityExpected, 0)
            const totalReceived = it.items.reduce((n, i) => n + i.quantityReceived, 0)
            const pctReceived = totalExpected > 0 ? Math.round((totalReceived / totalExpected) * 100) : 0
            return (
              <button
                key={it.id}
                onClick={() => setDrawerId(it.id)}
                className="block w-full text-left"
              >
                <Card>
                  <div className="flex items-start gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${TYPE_TONE[it.type] ?? ''}`}>{it.type}</span>
                        <Badge variant={STATUS_TONE[it.status] ?? 'default'} size="sm">{it.status.replace(/_/g, ' ')}</Badge>
                        {it.reference && <span className="text-[11px] text-slate-500 font-mono">{it.reference}</span>}
                      </div>
                      <div className="text-[13px] font-medium text-slate-900">
                        {it.fbaShipmentId
                          ? `FBA · ${it.fbaShipmentId}`
                          : it.purchaseOrder?.poNumber
                          ? `PO ${it.purchaseOrder.poNumber}`
                          : it.workOrder
                          ? `Work order × ${it.workOrder.quantity}`
                          : 'Manual inbound'}
                      </div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {it.items.length} SKU{it.items.length === 1 ? '' : 's'} · expected {totalExpected} · received {totalReceived}
                        {it.expectedAt && ` · ETA ${new Date(it.expectedAt).toLocaleDateString('en-GB')}`}
                      </div>
                      <div className="mt-2 h-1.5 bg-slate-100 rounded overflow-hidden">
                        <div
                          className={`h-full transition-all ${pctReceived === 100 ? 'bg-emerald-500' : 'bg-blue-500'}`}
                          style={{ width: `${pctReceived}%` }}
                        />
                      </div>
                    </div>
                    <ChevronRight size={16} className="text-slate-400 flex-shrink-0 mt-1" />
                  </div>
                </Card>
              </button>
            )
          })}
        </div>
      )}

      {drawerId && (
        <InboundDrawer id={drawerId} onClose={() => setDrawerId(null)} onChanged={fetchAll} />
      )}
      {createOpen && (
        <CreateInboundModal onClose={() => setCreateOpen(false)} onCreated={() => { setCreateOpen(false); fetchAll() }} />
      )}
      {fbaWizardOpen && (
        <FBAWizardModal onClose={() => setFbaWizardOpen(false)} onCreated={() => { setFbaWizardOpen(false); fetchAll() }} />
      )}
    </div>
  )
}

function InboundDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [shipment, setShipment] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [receiveBuf, setReceiveBuf] = useState<Record<string, { qty: number; qc: string }>>({})

  useEffect(() => {
    setLoading(true)
    fetch(`${getBackendUrl()}/api/fulfillment/inbound/${id}`, { cache: 'no-store' })
      .then((r) => r.json())
      .then(setShipment)
      .finally(() => setLoading(false))
  }, [id])

  const submitReceive = async () => {
    const updates = Object.entries(receiveBuf)
      .filter(([, v]) => v.qty > 0)
      .map(([itemId, v]) => ({ itemId, quantityReceived: v.qty, qcStatus: v.qc || undefined }))
    if (updates.length === 0) return alert('Enter received quantities')
    const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound/${id}/receive`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: updates }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      return alert(err.error ?? 'Receive failed')
    }
    setReceiveBuf({})
    const data = await res.json()
    setShipment(data)
    onChanged()
  }

  const close = async () => {
    await fetch(`${getBackendUrl()}/api/fulfillment/inbound/${id}/close`, { method: 'POST' })
    onChanged()
    onClose()
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" />
      <aside onClick={(e) => e.stopPropagation()} className="relative h-full w-full max-w-2xl bg-white shadow-2xl overflow-y-auto">
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="text-[13px] font-semibold text-slate-900">Inbound shipment</div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-4">
          {loading || !shipment ? <div className="text-[12px] text-slate-500">Loading…</div> : (
            <>
              <div className="flex items-center gap-2">
                <span className={`inline-block text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 border rounded ${TYPE_TONE[shipment.type]}`}>{shipment.type}</span>
                <Badge variant={STATUS_TONE[shipment.status] ?? 'default'} size="sm">{shipment.status.replace(/_/g, ' ')}</Badge>
                {shipment.reference && <span className="text-[12px] text-slate-500 font-mono">{shipment.reference}</span>}
              </div>

              <div>
                <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-2">Items</div>
                <table className="w-full text-[12px]">
                  <thead className="border-b border-slate-200">
                    <tr>
                      <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase text-slate-500">SKU</th>
                      <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase text-slate-500">Expected</th>
                      <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase text-slate-500">Already received</th>
                      <th className="px-2 py-1.5 text-right text-[10px] font-semibold uppercase text-slate-500">Receive now</th>
                      <th className="px-2 py-1.5 text-left text-[10px] font-semibold uppercase text-slate-500">QC</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shipment.items.map((it: any) => (
                      <tr key={it.id} className="border-b border-slate-100">
                        <td className="px-2 py-1.5 font-mono text-slate-700">{it.sku}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{it.quantityExpected}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-slate-700">{it.quantityReceived}</td>
                        <td className="px-2 py-1.5 text-right">
                          <input
                            type="number"
                            min="0"
                            value={receiveBuf[it.id]?.qty ?? ''}
                            onChange={(e) => setReceiveBuf({ ...receiveBuf, [it.id]: { qty: Number(e.target.value) || 0, qc: receiveBuf[it.id]?.qc ?? '' } })}
                            className="h-7 w-20 px-2 text-right tabular-nums border border-slate-200 rounded"
                          />
                        </td>
                        <td className="px-2 py-1.5">
                          <select
                            value={receiveBuf[it.id]?.qc ?? ''}
                            onChange={(e) => setReceiveBuf({ ...receiveBuf, [it.id]: { qty: receiveBuf[it.id]?.qty ?? 0, qc: e.target.value } })}
                            className="h-7 px-2 text-[12px] border border-slate-200 rounded"
                          >
                            <option value="">—</option>
                            <option value="PASS">PASS</option>
                            <option value="HOLD">HOLD</option>
                            <option value="FAIL">FAIL</option>
                          </select>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="flex items-center gap-2 pt-3 border-t border-slate-100">
                <button onClick={submitReceive} className="h-8 px-3 text-[12px] bg-emerald-50 text-emerald-700 border border-emerald-200 rounded hover:bg-emerald-100 inline-flex items-center gap-1.5">
                  <ArrowDownToLine size={12} /> Receive units
                </button>
                {shipment.status !== 'CLOSED' && (
                  <button onClick={close} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Close shipment</button>
                )}
                {shipment.fbaShipmentId && (
                  <span className="ml-auto text-[11px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded inline-flex items-center gap-1.5">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
                    FBA detail page lands in 8a
                  </span>
                )}
              </div>
            </>
          )}
        </div>
      </aside>
    </div>
  )
}

function CreateInboundModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [type, setType] = useState<'SUPPLIER' | 'MANUFACTURING' | 'TRANSFER'>('SUPPLIER')
  const [reference, setReference] = useState('')
  const [skus, setSkus] = useState<Array<{ sku: string; quantityExpected: number }>>([{ sku: '', quantityExpected: 1 }])
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type, reference,
          items: skus.filter((s) => s.sku.trim()),
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
      <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-lg shadow-2xl w-full max-w-xl max-h-[80vh] overflow-y-auto">
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <div className="text-[14px] font-semibold text-slate-900">New inbound shipment</div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100"><X size={16} /></button>
        </header>
        <div className="p-5 space-y-3">
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Type</div>
            <div className="flex items-center gap-2">
              {(['SUPPLIER', 'MANUFACTURING', 'TRANSFER'] as const).map((t) => (
                <button key={t} onClick={() => setType(t)} className={`h-7 px-3 text-[11px] border rounded ${type === t ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200'}`}>{t}</button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Reference</div>
            <input type="text" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="Supplier invoice #, transport doc, …" className="h-8 w-full px-2 text-[13px] border border-slate-200 rounded" />
          </div>
          <div>
            <div className="text-[11px] uppercase tracking-wider text-slate-500 font-semibold mb-1">Items</div>
            <div className="space-y-1.5">
              {skus.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="text" value={row.sku} onChange={(e) => setSkus(skus.map((s, j) => j === i ? { ...s, sku: e.target.value } : s))} placeholder="SKU" className="flex-1 h-7 px-2 text-[12px] font-mono border border-slate-200 rounded" />
                  <input type="number" min="1" value={row.quantityExpected} onChange={(e) => setSkus(skus.map((s, j) => j === i ? { ...s, quantityExpected: Number(e.target.value) || 1 } : s))} className="h-7 w-20 px-2 text-right tabular-nums border border-slate-200 rounded" />
                  <button onClick={() => setSkus(skus.filter((_, j) => j !== i))} className="h-7 w-7 inline-flex items-center justify-center text-slate-400 hover:text-rose-600"><X size={14} /></button>
                </div>
              ))}
            </div>
            <button onClick={() => setSkus([...skus, { sku: '', quantityExpected: 1 }])} className="mt-2 text-[11px] text-blue-600 hover:underline">+ Add SKU</button>
          </div>
        </div>
        <footer className="px-5 py-3 border-t border-slate-200 flex items-center gap-2 justify-end">
          <button onClick={onClose} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Cancel</button>
          <button onClick={submit} disabled={busy} className="h-8 px-3 text-[12px] bg-slate-900 text-white rounded hover:bg-slate-800 disabled:opacity-50">Create</button>
        </footer>
      </div>
    </div>
  )
}

function FBAWizardModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const [step, setStep] = useState<'plan' | 'commit'>('plan')
  const [items, setItems] = useState<Array<{ sku: string; quantity: number; productId?: string }>>([{ sku: '', quantity: 1 }])
  const [plan, setPlan] = useState<any>(null)
  const [busy, setBusy] = useState(false)

  const buildPlan = async () => {
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/fba/plan-shipment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: items.filter((i) => i.sku.trim()) }),
      })
      if (!res.ok) throw new Error('Plan failed')
      setPlan(await res.json())
      setStep('commit')
    } catch (e: any) {
      alert(e.message)
    } finally { setBusy(false) }
  }

  const commit = async () => {
    if (!plan?.shipmentPlans?.length) return
    const sp = plan.shipmentPlans[0]
    setBusy(true)
    try {
      const res = await fetch(`${getBackendUrl()}/api/fulfillment/fba/create-shipment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          shipmentId: sp.shipmentId,
          destinationFC: sp.destinationFC,
          name: `Send to ${sp.destinationFC}`,
          items: sp.items,
        }),
      })
      if (!res.ok) throw new Error('Create failed')
      onCreated()
    } catch (e: any) {
      alert(e.message)
    } finally { setBusy(false) }
  }

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center p-6" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/40" />
      <div onClick={(e) => e.stopPropagation()} className="relative bg-white rounded-lg shadow-2xl w-full max-w-2xl max-h-[80vh] overflow-y-auto">
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between">
          <div className="text-[14px] font-semibold text-slate-900 inline-flex items-center gap-2">
            <Truck size={16} className="text-orange-600" /> Send to Amazon FBA
          </div>
          <button onClick={onClose} className="h-7 w-7 inline-flex items-center justify-center rounded hover:bg-slate-100"><X size={16} /></button>
        </header>

        {/* H.0c — honesty banner. The plan + create + labels + transport
            endpoints are stubs today. Real SP-API integration lands in
            commits 8a–8d (createInboundShipmentPlan, getLabels,
            putTransportDetails, status polling). Until then this wizard
            writes Nexus-side records but doesn't reach Amazon. */}
        <div className="mx-5 mt-4 p-3 bg-amber-50 border border-amber-200 rounded-md text-[12px] text-amber-900">
          <div className="font-semibold mb-1 inline-flex items-center gap-1.5">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500" />
            Preview — does not submit to Amazon yet
          </div>
          <div className="text-amber-800 leading-snug">
            This wizard writes Nexus-side records (FBAShipment + mirrored InboundShipment)
            but the real SP-API integration ships in upcoming commits 8a–8d.
            Plan destinations + FNSKU labels are scaffolded; nothing reaches
            Amazon Seller Central. Use it to dry-run the flow only.
          </div>
        </div>

        {step === 'plan' && (
          <div className="p-5 space-y-3">
            <div className="text-[12px] text-slate-500">
              Step 1 of 2 — list the SKUs and quantities you want to ship to Amazon. Amazon will return a plan with destination FC + prep instructions.
            </div>
            <div className="space-y-1.5">
              {items.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input type="text" value={row.sku} onChange={(e) => setItems(items.map((s, j) => j === i ? { ...s, sku: e.target.value } : s))} placeholder="SKU" className="flex-1 h-7 px-2 text-[12px] font-mono border border-slate-200 rounded" />
                  <input type="number" min="1" value={row.quantity} onChange={(e) => setItems(items.map((s, j) => j === i ? { ...s, quantity: Number(e.target.value) || 1 } : s))} className="h-7 w-20 px-2 text-right tabular-nums border border-slate-200 rounded" />
                  <button onClick={() => setItems(items.filter((_, j) => j !== i))} className="h-7 w-7 inline-flex items-center justify-center text-slate-400 hover:text-rose-600"><X size={14} /></button>
                </div>
              ))}
            </div>
            <button onClick={() => setItems([...items, { sku: '', quantity: 1 }])} className="text-[11px] text-blue-600 hover:underline">+ Add SKU</button>
            <footer className="pt-3 border-t border-slate-200 flex items-center gap-2 justify-end">
              <button onClick={onClose} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Cancel</button>
              <button onClick={buildPlan} disabled={busy} className="h-8 px-3 text-[12px] bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50">Plan shipment →</button>
            </footer>
          </div>
        )}

        {step === 'commit' && plan && (
          <div className="p-5 space-y-3">
            <div className="text-[12px] text-slate-500">
              Step 2 of 2 — Amazon returned the following plan. Confirm to create the shipment, then download FNSKU labels and book transport.
            </div>
            {plan.shipmentPlans.map((sp: any, i: number) => (
              <div key={i} className="border border-slate-200 rounded-md p-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-[12px] font-semibold text-slate-900">FBA shipment {sp.shipmentId}</div>
                  <span className="text-[11px] font-mono bg-orange-50 text-orange-700 px-1.5 py-0.5 rounded">→ {sp.destinationFC}</span>
                </div>
                <ul className="space-y-1">
                  {sp.items.map((it: any, j: number) => (
                    <li key={j} className="flex items-center justify-between text-[12px]">
                      <span className="font-mono text-slate-700">{it.sku}</span>
                      <span className="tabular-nums text-slate-600">×{it.quantity}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <footer className="pt-3 border-t border-slate-200 flex items-center gap-2 justify-end">
              <button onClick={() => setStep('plan')} className="h-8 px-3 text-[12px] border border-slate-200 rounded hover:bg-slate-50">Back</button>
              <button onClick={commit} disabled={busy} className="h-8 px-3 text-[12px] bg-orange-600 text-white rounded hover:bg-orange-700 disabled:opacity-50">Create shipment</button>
            </footer>
          </div>
        )}
      </div>
    </div>
  )
}
