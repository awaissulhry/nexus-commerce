'use client'

// PO.9 — Supplier ack client. Token-gated, no auth, minimal chrome.

import { useCallback, useEffect, useState } from 'react'
import { AlertCircle, Calendar, CheckCircle2, Loader2, XCircle } from 'lucide-react'
import { getBackendUrl } from '@/lib/backend-url'

interface PublicItem {
  sku: string
  supplierSku: string | null
  quantityOrdered: number
  unitCostCents: number
  note: string | null
}

interface PublicPoView {
  poNumber: string
  status: string
  currencyCode: string
  expectedDeliveryDate: string | null
  supplierConfirmedDeliveryDate: string | null
  supplierConfirmedAt: string | null
  supplierAckExpiresAt: string | null
  expired: boolean
  supplier: { name: string; email: string | null } | null
  totalCents: number
  notes: string | null
  items: PublicItem[]
}

function fmt(cents: number, code: string): string {
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
    }).format(cents / 100)
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`
  }
}

type Outcome = 'confirmed' | 'declined' | null

export default function PoAckClient({ token }: { token: string }) {
  const [po, setPo] = useState<PublicPoView | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const [proposedEta, setProposedEta] = useState<string>('')
  const [declineReason, setDeclineReason] = useState<string>('')
  const [busy, setBusy] = useState<'confirm' | 'decline' | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<Outcome>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/po/ack/${token}`, {
        cache: 'no-store',
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      const data = (await res.json()) as PublicPoView
      setPo(data)
      if (data.expectedDeliveryDate) {
        setProposedEta(data.expectedDeliveryDate.slice(0, 10))
      }
      // Already-confirmed POs show the read-only outcome — no second
      // confirm allowed.
      if (data.supplierConfirmedAt) setOutcome('confirmed')
      if (data.status === 'CANCELLED') setOutcome('declined')
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }, [token])

  useEffect(() => {
    load()
  }, [load])

  const confirm = async () => {
    setBusy('confirm')
    setActionError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/po/ack/${token}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmedDeliveryDate: proposedEta || null,
        }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setOutcome('confirmed')
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const decline = async () => {
    setBusy('decline')
    setActionError(null)
    try {
      const res = await fetch(`${getBackendUrl()}/api/po/ack/${token}/decline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: declineReason || null }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      setOutcome('declined')
      await load()
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-base text-slate-500 inline-flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading…
        </div>
      </div>
    )
  }

  if (loadError || !po) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white border border-red-200 rounded-lg p-6">
          <div className="inline-flex items-center gap-2 text-red-700 font-semibold mb-2">
            <XCircle className="w-5 h-5" />
            Link unavailable
          </div>
          <p className="text-base text-slate-700">
            {loadError ?? 'This ack link is invalid or has been revoked.'}
          </p>
          <p className="text-sm text-slate-500 mt-3">
            If you received this from a buyer, please contact them to request a fresh link.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4">
      <div className="max-w-3xl mx-auto bg-white border border-default rounded-lg shadow-sm overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-default bg-slate-900 text-white">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h1 className="text-xl font-semibold font-mono">{po.poNumber}</h1>
            <span className="text-sm opacity-80">
              {po.expired ? 'Link expired' : `Expires ${po.supplierAckExpiresAt?.slice(0, 10) ?? '—'}`}
            </span>
          </div>
          {po.supplier?.name && (
            <div className="text-sm opacity-80 mt-1">For: {po.supplier.name}</div>
          )}
        </div>

        {/* Outcome banners */}
        {outcome === 'confirmed' && (
          <div className="px-6 py-4 bg-green-50 border-b border-green-200 inline-flex items-center gap-2 text-green-700 w-full">
            <CheckCircle2 className="w-5 h-5" />
            <span className="font-medium">
              You confirmed this PO
              {po.supplierConfirmedAt
                ? ` on ${new Date(po.supplierConfirmedAt).toLocaleDateString()}`
                : ''}
              .
              {po.supplierConfirmedDeliveryDate && (
                <> ETA: {po.supplierConfirmedDeliveryDate.slice(0, 10)}.</>
              )}
            </span>
          </div>
        )}
        {outcome === 'declined' && (
          <div className="px-6 py-4 bg-red-50 border-b border-red-200 inline-flex items-center gap-2 text-red-700 w-full">
            <XCircle className="w-5 h-5" />
            <span className="font-medium">You declined this PO. The buyer has been notified.</span>
          </div>
        )}

        {/* Summary grid */}
        <div className="px-6 py-4 grid grid-cols-2 md:grid-cols-4 gap-4 text-base border-b border-default">
          <Field label="Total">
            <span className="font-semibold tabular-nums">
              {fmt(po.totalCents, po.currencyCode)}
            </span>
          </Field>
          <Field label="Lines">
            <span>{po.items.length}</span>
          </Field>
          <Field label="Buyer's expected ETA">
            <span>
              {po.expectedDeliveryDate ? po.expectedDeliveryDate.slice(0, 10) : '—'}
            </span>
          </Field>
          <Field label="Currency">
            <span className="font-mono">{po.currencyCode}</span>
          </Field>
        </div>

        {/* Line items */}
        <div className="overflow-x-auto">
          <table className="w-full text-base">
            <thead className="bg-slate-50 text-sm text-slate-600 border-b border-default">
              <tr>
                <th className="text-left font-medium px-4 py-2 w-10">#</th>
                <th className="text-left font-medium px-4 py-2">SKU</th>
                <th className="text-right font-medium px-4 py-2">Qty</th>
                <th className="text-right font-medium px-4 py-2">Unit cost</th>
                <th className="text-right font-medium px-4 py-2">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {po.items.map((it, i) => (
                <tr key={i} className="border-b border-subtle last:border-0">
                  <td className="px-4 py-2 text-sm text-slate-500">{i + 1}</td>
                  <td className="px-4 py-2 font-mono text-sm">
                    {it.sku}
                    {it.supplierSku && it.supplierSku !== it.sku && (
                      <div className="text-xs text-slate-500">supplier ref: {it.supplierSku}</div>
                    )}
                    {it.note && (
                      <div className="text-xs text-slate-600 italic mt-0.5">{it.note}</div>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{it.quantityOrdered}</td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {fmt(it.unitCostCents, po.currencyCode)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-medium">
                    {fmt(it.unitCostCents * it.quantityOrdered, po.currencyCode)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {po.notes && (
          <div className="px-6 py-4 border-t border-default">
            <div className="text-sm font-semibold text-slate-700 uppercase tracking-wide mb-2">
              Buyer notes
            </div>
            <div className="text-base text-slate-900 whitespace-pre-wrap">{po.notes}</div>
          </div>
        )}

        {/* Confirm / decline panel */}
        {!outcome && !po.expired && (
          <div className="px-6 py-5 border-t border-default space-y-4 bg-slate-50">
            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">
                Confirmed delivery date
              </label>
              <div className="relative">
                <Calendar
                  size={14}
                  className="absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary pointer-events-none"
                />
                <input
                  type="date"
                  value={proposedEta}
                  onChange={(e) => setProposedEta(e.target.value)}
                  className="h-9 pl-8 pr-2 text-base border border-default rounded bg-white text-slate-900 w-56"
                />
              </div>
              <div className="text-sm text-slate-500 mt-1">
                Leave as-is if you can meet the buyer's date. Adjust if you need more time.
              </div>
            </div>

            <div>
              <label className="text-sm font-medium text-slate-700 block mb-1">
                If declining — reason (optional)
              </label>
              <input
                type="text"
                value={declineReason}
                onChange={(e) => setDeclineReason(e.target.value)}
                placeholder="Out of stock, price change, capacity, …"
                className="h-9 px-2 text-base border border-default rounded bg-white text-slate-900 w-full"
              />
            </div>

            {actionError && (
              <div className="text-sm text-red-700 inline-flex items-center gap-1">
                <AlertCircle className="w-3 h-3" /> {actionError}
              </div>
            )}

            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={confirm}
                disabled={busy !== null}
                className="h-9 px-4 inline-flex items-center gap-1.5 text-base font-medium rounded bg-slate-900 text-white hover:bg-slate-800 disabled:opacity-50"
              >
                {busy === 'confirm' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="w-4 h-4" />
                )}
                Confirm purchase order
              </button>
              <button
                type="button"
                onClick={decline}
                disabled={busy !== null}
                className="h-9 px-4 inline-flex items-center gap-1.5 text-base font-medium rounded bg-white text-red-700 border border-red-200 hover:bg-red-50 disabled:opacity-50"
              >
                {busy === 'decline' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <XCircle className="w-4 h-4" />
                )}
                Decline
              </button>
            </div>
          </div>
        )}

        <div className="px-6 py-3 text-xs text-slate-500 border-t border-default">
          This confirmation is logged on the buyer's side and can't be edited after submission.
          If anything looks wrong, contact the buyer directly before confirming.
        </div>
      </div>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-sm text-slate-500 uppercase tracking-wide mb-1">{label}</div>
      <div className="text-base text-slate-900">{children}</div>
    </div>
  )
}
